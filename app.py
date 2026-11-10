"""WebLingo URL translator server.

Local:  uvicorn app:app --host 127.0.0.1 --port 8000
Public: see README (Docker / Render). Configure via environment variables.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from extractor import extract_page
from limits import DailyBudget, RateLimiter
from security import UnsafeURL, assert_public_dns, parse_public_url, pinned_request_url
from translation import TranslateService, TranslationError

ROOT = Path(__file__).resolve().parent
META_CHARSET = re.compile(rb'<meta[^>]+charset=["\']?\s*([A-Za-z0-9_\-:.]+)', re.I)
MAX_HTML_BYTES = 5_000_000


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


APP_PASSWORD = os.getenv('APP_PASSWORD', '')
APP_USERNAME = os.getenv('APP_USERNAME', 'weblingo')
extract_limiter = RateLimiter(env_int('RATE_LIMIT_EXTRACT', 20), 600)      # pages / IP / 10 min
translate_limiter = RateLimiter(env_int('RATE_LIMIT_TRANSLATE', 200), 600)  # requests / IP / 10 min
ai_budget = DailyBudget(env_int('AI_DAILY_CHAR_LIMIT', 200_000))            # AI chars / day (all users)
FREE_PAGE_CHAR_LIMIT = env_int('FREE_PAGE_CHAR_LIMIT', 20_000)   # free chars per translation run
AI_PAGE_CHAR_LIMIT = env_int('AI_PAGE_CHAR_LIMIT', 100_000)      # AI chars per translation run
fetch_slots = asyncio.Semaphore(env_int('MAX_CONCURRENT_FETCHES', 8))
app = FastAPI(title='WebLingo - Website Translator', docs_url=None, redoc_url=None)
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
translator = TranslateService()


class ExtractRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class TranslationItem(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1, max_length=7000)


class TranslateRequest(BaseModel):
    items: list[TranslationItem] = Field(min_length=1, max_length=14)
    source_language: str = 'auto'
    target_language: str = 'ja'
    provider: str = 'free'
    tone: str = 'casual'

    @field_validator('source_language', 'target_language')
    @classmethod
    def validate_lang(cls, value: str) -> str:
        if value not in ('auto', 'ja', 'en', 'ko', 'zh-CN', 'fr', 'de', 'es', 'pt', 'it'):
            raise ValueError('unsupported language')
        return value

    @field_validator('tone')
    @classmethod
    def validate_tone(cls, value: str) -> str:
        if value not in ('casual', 'polite'):
            raise ValueError('unsupported tone')
        return value

    @field_validator('provider')
    @classmethod
    def validate_provider(cls, value: str) -> str:
        if value not in ('free', 'openai'):
            raise ValueError('unsupported provider')
        return value


def decode_html(body: bytes, header_charset: str | None) -> str:
    """Decode with the HTTP charset, else <meta charset>, else UTF-8 (e.g. Shift_JIS pages)."""
    candidates = [header_charset]
    found = META_CHARSET.search(body[:8192])
    if found:
        candidates.append(found.group(1).decode('ascii', 'ignore'))
    if body.startswith(b'\xef\xbb\xbf'):
        candidates.insert(0, 'utf-8-sig')
    for name in candidates:
        if not name:
            continue
        try:
            return body.decode(name, errors='replace')
        except LookupError:
            continue
    return body.decode('utf-8', errors='replace')


async def retrieve_html(url: str) -> tuple[str, str]:
    current_url = parse_public_url(url)
    # trust_env=False: never route user-supplied URLs through env proxies (keeps IP pinning intact)
    async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(18.0), headers={
        'User-Agent': 'Mozilla/5.0 (compatible; WebLingoReader/1.0; +https://example.org)',
        'Accept': 'text/html,application/xhtml+xml',
    }) as client:
        for _ in range(5):
            ip = assert_public_dns(current_url)
            target, host_header = pinned_request_url(current_url, ip)
            extensions = {'sni_hostname': urlsplit(current_url).hostname} if current_url.startswith('https') else {}
            async with client.stream('GET', target, headers={'Host': host_header}, extensions=extensions) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get('location')
                    if not location:
                        raise HTTPException(400, 'リダイレクト先が取得できません。')
                    current_url = parse_public_url(urljoin(current_url, location))
                    continue
                if response.status_code >= 400:
                    raise HTTPException(422, f'対象サイトから HTTP {response.status_code} が返されました。')
                content_type = response.headers.get('content-type', '').lower()
                if not any(ct in content_type for ct in ('text/html', 'application/xhtml+xml')):
                    raise HTTPException(415, 'HTML以外のURLには対応していません。')
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_HTML_BYTES:
                        raise HTTPException(413, 'ページのサイズが上限（2MB）を超えています。')
                return decode_html(bytes(body), response.charset_encoding), current_url
    raise HTTPException(400, 'リダイレクトが多すぎるため中断しました。')


def client_ip(request: Request) -> str:
    # With uvicorn --proxy-headers this is the real visitor IP behind Render / a reverse proxy.
    return request.client.host if request.client else 'unknown'


def authorized(request: Request) -> bool:
    if not APP_PASSWORD:
        return True
    header = request.headers.get('authorization', '')
    if not header.lower().startswith('basic '):
        return False
    try:
        user, _, password = base64.b64decode(header[6:]).decode('utf-8').partition(':')
    except (binascii.Error, UnicodeDecodeError):
        return False
    return secrets.compare_digest(user, APP_USERNAME) & secrets.compare_digest(password, APP_PASSWORD)


def check_rate(limiter: RateLimiter, request: Request) -> None:
    wait = limiter.hit(client_ip(request))
    if wait:
        raise HTTPException(429, f'リクエストが多すぎます。約{int(wait // 60) + 1}分後に再試行してください。')


@app.middleware('http')
async def security_headers(request: Request, call_next):
    if request.url.path != '/healthz' and not authorized(request):
        response = JSONResponse(status_code=401, content={'detail': '認証が必要です。'},
                                headers={'WWW-Authenticate': 'Basic realm="WebLingo", charset="UTF-8"'})
    else:
        response = await call_next(request)
    if request.url.scheme == 'https':
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'

    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' https: data:; connect-src 'self' https://api.mymemory.translated.net; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'"
    )
    return response


@app.get('/')
async def index():
    return FileResponse(ROOT / 'static' / 'index.html', headers={'Cache-Control': 'no-cache'})


@app.get('/healthz')
async def healthz():
    return {'ok': True}


@app.get('/api/status')
async def status():
    remaining = ai_budget.remaining()
    return {'ok': True, 'openai_available': bool(os.getenv('OPENAI_API_KEY')) and remaining != 0,
            'max_free_chars': FREE_PAGE_CHAR_LIMIT, 'max_ai_chars': AI_PAGE_CHAR_LIMIT, 'ai_daily_remaining': remaining}


@app.post('/api/extract')
async def extract(req: ExtractRequest, request: Request):
    check_rate(extract_limiter, request)
    try:
        async with fetch_slots:
            html, final_url = await retrieve_html(req.url)
    except UnsafeURL as exc:
        raise HTTPException(400, str(exc)) from exc
    except (httpx.HTTPError, UnicodeError) as exc:
        raise HTTPException(502, 'ページを取得できません。URL、ネットワーク、アクセス制限を確認してください。') from exc
    page = extract_page(html, final_url)
    return {'url': final_url, **page}


@app.post('/api/translate')
async def translate(req: TranslateRequest, request: Request):
    if req.target_language == 'auto':
        raise HTTPException(400, '翻訳先言語を指定してください。')
    chars = sum(len(item.text) for item in req.items)
    if chars > 7600:
        raise HTTPException(413, '一度に翻訳できる文字数を超えています。')
    check_rate(translate_limiter, request)
    charged = 0
    if req.provider == 'openai' and req.source_language != req.target_language:
        if not ai_budget.consume(chars):
            raise HTTPException(429, 'AI翻訳の本日の利用上限に達しました。無料翻訳をご利用いただくか、明日以降に再試行してください。')
        charged = chars
    try:
        result = await translator.translate([i.model_dump() for i in req.items],
                                           req.source_language, req.target_language, req.provider, req.tone)
    except TranslationError as exc:
        ai_budget.refund(charged)
        raise HTTPException(502, str(exc)) from exc
    return {'translations': result}


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    return JSONResponse(status_code=422, content={'detail': '入力内容が正しくありません（言語・翻訳エンジン・文字数を確認してください）。'})


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    return JSONResponse(status_code=exc.status_code, content={'detail': exc.detail})
