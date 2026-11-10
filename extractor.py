"""Convert arbitrary HTML into a safe, text-first bilingual reading view."""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup, Tag

REMOVE_TAGS = 'script style noscript template iframe embed object form nav aside svg canvas video audio'.split()
CANDIDATE_TAGS = set('h1 h2 h3 h4 h5 h6 p li blockquote pre figcaption th td'.split())
ANCESTOR_BLOCKS = set('li blockquote pre th td'.split())
MAX_BLOCKS = 220
MAX_CHARS = 42000
MAX_BLOCK_CHARS = 3000  # keep each block below the /api/translate per-item limit


def _split_long(text: str, limit: int = MAX_BLOCK_CHARS) -> list[str]:
    """Split very long text at sentence / space boundaries so every piece is translatable."""
    pieces = []
    while len(text) > limit:
        window = text[:limit]
        cut = max(window.rfind(mark) for mark in ('. ', '。', '! ', '? ', '！', '？'))
        if cut < limit // 3:
            cut = window.rfind(' ')
        cut = cut + 1 if cut >= limit // 3 else limit
        pieces.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        pieces.append(text)
    return pieces


def _clean_text(text: str) -> str:
    return re.sub(r'\s+', ' ', text or '').strip()


def _safe_link(link: str, base_url: str) -> str | None:
    if not link:
        return None
    absolute = urljoin(base_url, link.strip())
    return absolute if urlsplit(absolute).scheme in ('http', 'https') else None


def _best_content(soup: BeautifulSoup) -> Tag:
    choices = []
    for item in soup.select('article, main, [role="main"]'):
        chars = len(_clean_text(item.get_text(' ', strip=True)))
        if chars >= 110:
            weight = 1.35 if item.name == 'article' else 1.2
            choices.append((chars * weight, item))
    return max(choices, key=lambda x: x[0])[1] if choices else (soup.body or soup)


def extract_page(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, 'html.parser')
    title = _clean_text(soup.title.get_text(' ', strip=True)) if soup.title else urlsplit(url).hostname or url
    lang = str(soup.html.get('lang', '') if soup.html else '').replace('_', '-').split('-')[0].strip().lower()
    for element in soup(REMOVE_TAGS):
        element.decompose()
    for element in soup.select('header, footer'):
        if not element.find_parent(['article', 'main']):
            element.decompose()
    content = _best_content(soup)
    blocks = []
    chars = 0
    truncated = False
    seen = set()
    for tag in content.descendants:
        if not isinstance(tag, Tag):
            continue
        if tag.name not in CANDIDATE_TAGS and tag.name != 'img':
            continue
        if any(parent.name in ANCESTOR_BLOCKS for parent in tag.parents if parent is not content):
            continue
        if tag.name == 'img':
            source = _safe_link(tag.get('src', ''), url)
            alt = _clean_text(tag.get('alt', ''))
            if source and len([b for b in blocks if b['type']=='image']) < 12:
                blocks.append({'id': f'b{len(blocks)}', 'type': 'image', 'text': alt, 'image_url': source})
            continue
        text = _clean_text(tag.get_text(' ', strip=True))
        if not text or (len(text) < 3 and tag.name not in ('th', 'td')):
            continue
        if text in seen and len(text) > 24:
            continue
        if chars + len(text) > MAX_CHARS or len(blocks) >= MAX_BLOCKS:
            truncated = True
            break
        seen.add(text)
        kind = ('heading' if tag.name.startswith('h') else
                'code' if tag.name == 'pre' else
                'quote' if tag.name == 'blockquote' else
                'list' if tag.name == 'li' else
                'table' if tag.name in ('td', 'th') else 'text')
        link = tag.find('a', href=True)
        href = _safe_link(link.get('href', ''), url) if link is not None else None
        for piece in _split_long(text):
            item = {'id': f'b{len(blocks)}', 'type': kind, 'text': piece}
            if kind == 'heading':
                item['level'] = int(tag.name[1])
            if href:
                item['href'] = href
                href = None  # link only on the first piece
            blocks.append(item)
        chars += len(text)
    if not blocks:
        plain = _clean_text(content.get_text(' ', strip=True))[:MAX_CHARS]
        for piece in _split_long(plain) if plain else []:
            blocks.append({'id': f'b{len(blocks)}', 'type': 'text', 'text': piece})
    return {'title': title[:240], 'detected_language': lang or 'unknown',
            'blocks': blocks, 'total_chars': chars, 'truncated': truncated}
