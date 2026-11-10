import pytest
from fastapi.testclient import TestClient
from extractor import extract_page
from security import UnsafeURL, is_public_ip, parse_public_url
from translation import split_utf8
from app import app


def test_public_url_parsing():
    assert parse_public_url('example.com/path') == 'https://example.com/path'
    assert parse_public_url('https://example.com') == 'https://example.com'
    for bad in ['http://127.0.0.1:8000', 'http://192.168.1.1', 'http://10.1.2.3', 'http://localhost',
                'file:///etc/passwd', 'http://example.com:9000', 'https://user:pass@example.com',
                'http://169.254.169.254/latest/meta-data', '']:
        with pytest.raises(UnsafeURL):
            parse_public_url(bad)


def test_ip_check():
    assert is_public_ip('8.8.8.8')
    assert not is_public_ip('::1')
    assert not is_public_ip('172.16.0.1')
    assert not is_public_ip('100.64.0.1')


def test_extract_preserves_sections_safely():
    sample = '''<html lang="en"><head><title>Sample document</title><script>alert(1)</script></head>
    <body><nav>Top navigation</nav><main><h1>Working with AWS</h1><p>A simple first paragraph.</p>
    <ul><li>Item one with a <a href="/doc">link</a></li><li>Item two for the list</li></ul>
    <blockquote>Important information from the article</blockquote>
    <img alt="Chart" src="/picture.png"></main><footer>Contact the site</footer></body></html>'''
    result = extract_page(sample, 'https://example.com/page')
    assert result['detected_language'] == 'en'
    assert result['title'] == 'Sample document'
    assert [b['type'] for b in result['blocks']] == ['heading', 'text', 'list', 'list', 'quote', 'image']
    assert result['blocks'][2]['href'] == 'https://example.com/doc'
    assert result['blocks'][-1]['image_url'] == 'https://example.com/picture.png'
    assert 'Top navigation' not in ''.join(b['text'] for b in result['blocks'])


def test_split_utf8_bytes():
    text = 'あいうえお '*110
    chunks = split_utf8(text)
    assert len(chunks) > 1
    assert all(len(x.encode('utf-8')) <= 480 for x in chunks)
    assert ' '.join(chunks) == text.strip()


def test_site_and_status():
    client = TestClient(app)
    assert client.get('/').status_code == 200
    assert 'WebLingo' in client.get('/').text
    response=client.get('/api/status')
    assert response.status_code == 200
    assert response.json()['max_free_chars']==20000 and response.json()['max_ai_chars']==100000
    assert client.post('/api/extract', json={'url':'http://127.0.0.1'}).status_code == 400


def test_reject_invalid_provider_and_request():
    client = TestClient(app)
    bad = {'items':[{'id':'b1','text':'Hi'}], 'source_language':'en','target_language':'ja','provider':'bad'}
    assert client.post('/api/translate',json=bad).status_code==422
    bad['provider']='openai'
    bad['target_language']='auto'
    assert client.post('/api/translate',json=bad).status_code==400


def test_extract_api_with_mocked_fetch(monkeypatch):
    import app as server
    sample = '<html lang="en"><head><title>Demo Article</title></head><body><main><h1>Welcome to our page</h1><p>Read this informative content from the public internet.</p></main></body></html>'
    async def mock_retrieve(url):
        return sample, url
    monkeypatch.setattr(server, 'retrieve_html', mock_retrieve)
    response = TestClient(app).post('/api/extract', json={'url':'https://example.com/post'})
    assert response.status_code == 200
    data=response.json()
    assert data['title']=='Demo Article'
    assert data['blocks'][0]['text']=='Welcome to our page'


def test_translate_api_with_mocked_provider(monkeypatch):
    import app as server
    async def mock_translate(items, source, target, provider, tone="casual"):
        return [{'id': x['id'], 'text': 'こんにちは'} for x in items]
    monkeypatch.setattr(server.translator, 'translate', mock_translate)
    response = TestClient(app).post('/api/translate', json={
        'items':[{'id':'b0','text':'Hello'}],
        'source_language':'en', 'target_language':'ja', 'provider':'free',
    })
    assert response.status_code == 200
    assert response.json()['translations']==[{'id':'b0','text':'こんにちは'}]


def test_long_blocks_are_split_under_api_limit():
    long_text = ('This is a long sentence for testing. ' * 400).strip()
    result = extract_page(f'<html><body><main><p>{long_text}</p></main></body></html>', 'https://example.com')
    assert len(result['blocks']) > 1
    assert all(len(b['text']) <= 3000 for b in result['blocks'])
    assert ' '.join(b['text'] for b in result['blocks']) == long_text


def test_table_cells_are_not_duplicated():
    sample = '<html><body><main><table><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></table>' \
             '<p>Paragraph outside the table for content.</p></main></body></html>'
    texts = [b['text'] for b in extract_page(sample, 'https://example.com')['blocks']]
    assert texts.count('Cell A') == 1 and texts.count('Cell B') == 1


def test_lang_with_underscore():
    assert extract_page('<html lang="EN_us"><body><p>Hello world text</p></body></html>', 'https://e.com')['detected_language'] == 'en'


def test_decode_html_uses_meta_charset():
    from app import decode_html
    body = '<html><head><meta charset="Shift_JIS"></head><body>日本語のページ</body></html>'.encode('shift_jis')
    assert '日本語のページ' in decode_html(body, None)
    assert '日本語' in decode_html('<p>日本語</p>'.encode('utf-8'), None)
    assert 'ü' in decode_html('über'.encode('latin-1'), 'iso-8859-1')


def test_validation_error_message_is_japanese():
    client = TestClient(app)
    res = client.post('/api/translate', json={'items': [{'id': 'b1', 'text': 'x' * 8000}]})
    assert res.status_code == 422
    assert isinstance(res.json()['detail'], str)


def test_pinned_request_url():
    from security import pinned_request_url
    assert pinned_request_url('https://example.com/a?b=1', '93.184.216.34') == ('https://93.184.216.34/a?b=1', 'example.com')
    assert pinned_request_url('http://example.com:80/x', '2606:2800::1') == ('http://[2606:2800::1]:80/x', 'example.com:80')


def test_rate_limiter_and_budget():
    from limits import DailyBudget, RateLimiter
    limiter = RateLimiter(2, 60)
    assert limiter.hit('a') == 0 and limiter.hit('a') == 0
    assert limiter.hit('a') > 0
    assert limiter.hit('b') == 0
    budget = DailyBudget(100)
    assert budget.consume(80) and not budget.consume(30)
    budget.refund(80)
    assert budget.remaining() == 100


def test_translate_rate_limit_returns_429(monkeypatch):
    import app as server
    from limits import RateLimiter
    async def mock_translate(items, source, target, provider, tone="casual"):
        return [{'id': x['id'], 'text': 'ok'} for x in items]
    monkeypatch.setattr(server.translator, 'translate', mock_translate)
    monkeypatch.setattr(server, 'translate_limiter', RateLimiter(1, 600))
    client = TestClient(app)
    body = {'items': [{'id': 'b0', 'text': 'Hello'}], 'source_language': 'en', 'target_language': 'ja', 'provider': 'free'}
    assert client.post('/api/translate', json=body).status_code == 200
    res = client.post('/api/translate', json=body)
    assert res.status_code == 429 and '再試行' in res.json()['detail']


def test_ai_daily_budget(monkeypatch):
    import app as server
    from limits import DailyBudget
    async def mock_translate(items, source, target, provider, tone="casual"):
        return [{'id': x['id'], 'text': 'ok'} for x in items]
    monkeypatch.setattr(server.translator, 'translate', mock_translate)
    monkeypatch.setattr(server, 'ai_budget', DailyBudget(8))
    client = TestClient(app)
    body = {'items': [{'id': 'b0', 'text': 'Hello'}], 'source_language': 'en', 'target_language': 'ja', 'provider': 'openai'}
    assert client.post('/api/translate', json=body).status_code == 200
    assert client.post('/api/translate', json=body).status_code == 429


def test_optional_password(monkeypatch):
    import base64
    import app as server
    monkeypatch.setattr(server, 'APP_PASSWORD', 'secret')
    client = TestClient(app)
    assert client.get('/').status_code == 401
    assert client.get('/healthz').status_code == 200
    token = base64.b64encode(b'weblingo:secret').decode()
    assert client.get('/', headers={'Authorization': f'Basic {token}'}).status_code == 200
    bad = base64.b64encode(b'weblingo:wrong').decode()
    assert client.get('/', headers={'Authorization': f'Basic {bad}'}).status_code == 401


def test_tone_is_validated_and_passed(monkeypatch):
    import app as server
    seen = {}
    async def mock_translate(items, source, target, provider, tone='casual'):
        seen['tone'] = tone
        return [{'id': x['id'], 'text': 'ok'} for x in items]
    monkeypatch.setattr(server.translator, 'translate', mock_translate)
    client = TestClient(app)
    body = {'items': [{'id': 'b0', 'text': 'Hello'}], 'source_language': 'en', 'target_language': 'ja', 'provider': 'free'}
    assert client.post('/api/translate', json=body).status_code == 200 and seen['tone'] == 'casual'
    assert client.post('/api/translate', json={**body, 'tone': 'polite'}).status_code == 200 and seen['tone'] == 'polite'
    assert client.post('/api/translate', json={**body, 'tone': 'rude'}).status_code == 422


def test_ai_prompt_includes_tone(monkeypatch):
    import asyncio, json
    import translation
    captured = {}
    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {'choices': [{'message': {'content': json.dumps({'translations': [{'id': '0', 'text': 'やあ'}]})}}]}
    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, headers=None, json=None):
            captured['system'] = json['messages'][0]['content']; return FakeResp()
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setattr(translation.httpx, 'AsyncClient', FakeClient)
    out = asyncio.run(translation.TranslateService().translate([{'id': 'b0', 'text': 'Hi'}], 'en', 'ja', 'openai', 'casual'))
    assert out == [{'id': 'b0', 'text': 'やあ'}]
    assert 'conversational' in captured['system'] and 'です・ます' in captured['system']


def test_extractor_handles_long_pages():
    paras = ''.join(f'<p>Paragraph {i} ' + 'word ' * 40 + '</p>' for i in range(500))
    result = extract_page(f'<html><body><main>{paras}</main></body></html>', 'https://example.com')
    assert len(result['blocks']) == 500 and not result['truncated']
