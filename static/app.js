'use strict';

const $ = (id) => document.getElementById(id);
const state = { page: null, translations: new Map(), abort: null, fontSize: 14, dark: false, freeLimit: 4000, aiLimit: 30000, openai: false };
const LANG_NAMES = { auto:'自動検出', en:'英語', ja:'日本語', ko:'韓国語', 'zh-CN':'中国語', fr:'フランス語', de:'ドイツ語', es:'スペイン語', pt:'ポルトガル語', it:'イタリア語' };

function setTheme(dark) {
  state.dark = dark;
  document.body.classList.toggle('dark', dark);
  $('themeBtn').textContent = dark ? '☼' : '☾';
  try { localStorage.setItem('webLingoTheme', dark ? 'dark' : 'light'); } catch (_) {}
}
function setStatus(message, progress = 5) {
  $('statusArea').hidden = false;
  $('statusText').textContent = message;
  $('statusProgress').style.width = `${Math.min(100, Math.max(0, progress))}%`;
}
function clearStatus(){ $('statusArea').hidden = true; }
function showError(message) { $('errorText').textContent = message; $('errorArea').hidden = false; }
function clearError(){ $('errorArea').hidden = true; }
function isAbort(err){ return err && err.name === 'AbortError'; }
function busy(flag) { $('translateBtn').disabled = flag; $('translateBtnText').textContent = flag ? '翻訳中…' : 'ページを翻訳'; }
function readHistory(){ try {return JSON.parse(localStorage.getItem('webLingoHistory') || '[]') || [];} catch (_) {return [];} }
function storeHistory(url, title){
  try {
    const updated = [{url, title, date:Date.now()}, ...readHistory().filter(x => x.url !== url)].slice(0, 7);
    localStorage.setItem('webLingoHistory', JSON.stringify(updated));
  } catch (_) {}
  renderHistory();
}
function renderHistory(){
  const list = $('historyList'); list.replaceChildren();
  const items = readHistory();
  $('historySection').hidden = !items.length;
  items.forEach(item => {
    const button = document.createElement('button');
    button.className = 'history-item'; button.type = 'button';
    button.textContent = item.title || item.url;
    button.title = item.url;
    button.addEventListener('click', () => { $('urlInput').value = item.url; $('translateForm').requestSubmit(); window.scrollTo({top:0,behavior:'smooth'}); });
    list.append(button);
  });
}
function createBlock(block, translated = false){
  const node = document.createElement(block.type === 'image' ? 'figure' : 'div');
  node.className = `reading-block type-${block.type}`;
  node.dataset.id = block.id;
  if (block.level) node.dataset.level = String(block.level);
  if (block.type === 'image') {
    const img = document.createElement('img'); img.src = block.image_url;
    img.alt = block.text || 'ページ内の画像'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    node.append(img);
    if (block.text) { const cap = document.createElement('figcaption'); cap.textContent = block.text; node.append(cap); }
  } else if (translated) {
    node.classList.add('is-pending');
    const placeholder = document.createElement('span'); placeholder.className = 'translation-pending';
    placeholder.textContent = '翻訳しています…'; node.append(placeholder);
  } else {
    node.textContent = block.text;
    if (block.href) {
      const a = document.createElement('a'); a.href = block.href;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = ' ↗';
      a.setAttribute('aria-label','リンクを別タブで開く'); node.append(a);
    }
  }
  if (block.type !== 'heading') node.style.fontSize = `${state.fontSize}px`;
  return node;
}
function renderReader(page){
  $('welcomePanel').hidden = true;
  $('resultPanel').hidden = false;
  $('pageTitle').textContent = page.title || new URL(page.url).hostname;
  $('pageLink').href = page.url;
  $('originalInfo').textContent = `${page.blocks.length} セクション`;
  $('translatedInfo').textContent = `${LANG_NAMES[$('targetLang').value] || $('targetLang').value}に翻訳`;
  const originalLang = $('sourceLang').value !== 'auto' ? $('sourceLang').value : page.detected_language;
  document.querySelector('.emblem-original').textContent = (originalLang && originalLang !== 'unknown' ? originalLang : '??').slice(0,2).toUpperCase();
  $('translatedEmblem').textContent = $('targetLang').value.slice(0,2).toUpperCase();
  const origFragment = document.createDocumentFragment(), tranFragment = document.createDocumentFragment();
  page.blocks.forEach(block => { origFragment.append(createBlock(block)); tranFragment.append(createBlock(block,true)); });
  $('originalBody').replaceChildren(origFragment);
  $('translatedBody').replaceChildren(tranFragment);
}
function applyTranslation(item) {
  state.translations.set(item.id, item.text);
  const node = Array.from($('translatedBody').children).find(el => el.dataset.id === item.id);
  if (node) { node.textContent = item.text; node.classList.remove('is-pending'); }
}
function markUntranslated(ids, message){
  ids.forEach(id => {
    const node = Array.from($('translatedBody').children).find(el => el.dataset.id === id);
    if (node) { node.replaceChildren(); node.classList.remove('is-pending'); const span = document.createElement('span'); span.className='translation-failed'; span.textContent=message; node.append(span); }
  });
}
function markPendingAsCancelled(){
  const ids = Array.from($('translatedBody').querySelectorAll('.reading-block.is-pending')).map(el => el.dataset.id);
  markUntranslated(ids, '翻訳を中止しました');
}
function createBatches(blocks, maxBatchChars = 1800, maxBatchItems = 9){
  const batches=[]; let items=[], count=0;
  const flush=()=>{if(items.length){batches.push(items);items=[];count=0;}};
  for(const block of blocks){
    if (items.length>=maxBatchItems || count+block.text.length>maxBatchChars) flush();
    items.push({id:block.id, text:block.text}); count+=block.text.length;
  }
  flush(); return batches;
}
// ---- Free translation directly from the browser (each visitor uses their own MyMemory quota / IP) ----
const MYMEMORY_URL='https://api.mymemory.translated.net/get';
const freeCache=new Map();
const utf8Len=(t)=>new TextEncoder().encode(t).length;
function splitUtf8(text, maxBytes=480){
  text=text.trim();
  if(utf8Len(text)<=maxBytes) return [text];
  const out=[]; let chunk='';
  for(const word of text.split(' ')){
    const piece=(chunk?' ':'')+word;
    if(utf8Len(word)>maxBytes){
      if(chunk){out.push(chunk);chunk='';}
      for(const ch of word){ if(utf8Len(chunk+ch)>maxBytes){out.push(chunk);chunk='';} chunk+=ch; }
    } else if(utf8Len(chunk+piece)>maxBytes){ out.push(chunk); chunk=word; }
    else chunk+=piece;
  }
  if(chunk) out.push(chunk);
  return out;
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
class QuotaError extends Error {}
function quotaError(body){
  // MyMemory: "... NEXT AVAILABLE IN 00 HOURS 24 MINUTES 54 SECONDS ..."
  const m=/NEXT AVAILABLE IN\s+(\d+)\s+HOURS?\s+(\d+)\s+MINUTES?/i.exec(body||'');
  const wait=m?(Number(m[1])*60+Number(m[2])):60;
  const err=new QuotaError(m?`約${Number(m[1])?`${Number(m[1])}時間`:''}${Number(m[2])}分後に回復します`:'しばらくすると回復します');
  err.waitMs=(wait+1)*60000; return err;
}
function myMemoryEmail(){
  try { const v=(localStorage.getItem('webLingoMyMemoryEmail')||'').trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?v:''; } catch(_) { return ''; }
}
async function myMemoryPart(part, source, target, signal){
  const email=myMemoryEmail();
  const url=`${MYMEMORY_URL}?q=${encodeURIComponent(part)}&langpair=${encodeURIComponent(`${source}|${target}`)}${email?`&de=${encodeURIComponent(email)}`:''}`;
  for(let attempt=0; attempt<4; attempt++){
    const res=await fetch(url,{signal,referrerPolicy:'no-referrer',credentials:'omit'});
    if(res.status===429 || res.status>=500){
      const body=await res.text().catch(()=> '');
      if(body.includes('MYMEMORY WARNING')) throw quotaError(body); // daily quota used up: retrying is pointless
      await sleep(1200*2**attempt); continue;
    }
    if(!res.ok) throw new Error(`無料翻訳サービスがエラーを返しました（HTTP ${res.status}）。`);
    const data=await res.json();
    const raw=String((data.responseData&&data.responseData.translatedText)||'');
    if(data.quotaFinished || raw.startsWith('MYMEMORY WARNING')) throw quotaError(raw);
    const status=Number(data.responseStatus||200);
    if(status===429){ await sleep(1200*2**attempt); continue; }
    if(status!==200) throw new Error(String(data.responseDetails||'無料翻訳の利用制限に達しました。'));
    const text=data.responseData&&data.responseData.translatedText;
    if(!text) throw new Error('翻訳サービスから結果が返されませんでした。');
    const box=document.createElement('textarea'); box.innerHTML=text; return box.value; // unescape HTML entities safely
  }
  throw new Error('無料翻訳サービスが混雑しています。時間をおいて再試行してください。');
}
async function translateFreeInBrowser(items, source, target, signal){
  if(source===target) return items.map(x=>({id:x.id,text:x.text}));
  const results=[];
  for(const item of items){
    const key=`${source}|${target}|${item.text}`;
    if(!freeCache.has(key)){
      const parts=[];
      for(const part of splitUtf8(item.text)) parts.push(await myMemoryPart(part, source, target, signal));
      freeCache.set(key, parts.join(' '));
    }
    results.push({id:item.id, text:freeCache.get(key)});
  }
  return results;
}
function applyTone(translations, target, provider){
  // MyMemory cannot be told a style, so make Japanese free translations conversational afterwards.
  if(provider!=='free' || target!=='ja' || $('tone').value!=='casual' || typeof window.toCasualJa!=='function') return translations;
  return translations.map(t=>({id:t.id, text:window.toCasualJa(t.text)}));
}
async function translateBatch(batch, source, target, provider, signal){
  const tone=$('tone').value;
  const quotaOut=provider==='free' && Date.now()<(state.quotaUntil||0);
  if(provider==='free' && !quotaOut){
    try { return applyTone(await translateFreeInBrowser(batch, source, target, signal), target, provider); }
    catch(err){
      if(isAbort(err)) throw err;
      if(err instanceof QuotaError){ state.quotaUntil=Date.now()+err.waitMs; state.quotaMessage=err.message; }
      /* fall back to the server below */
    }
  }
  try {
    const data=await postJson('/api/translate', {items:batch,source_language:source,target_language:target,provider,tone},signal);
    return applyTone(data.translations, target, provider);
  } catch(err){
    if(!isAbort(err) && provider==='free' && Date.now()<(state.quotaUntil||0)) throw new QuotaError(state.quotaMessage||'しばらくすると回復します');
    throw err;
  }
}
async function postJson(path, body, signal){
  const res = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  let data={}; try{data=await res.json();}catch(_){}
  if(!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}: サーバーエラー`);
  return data;
}
function normalizeUrl(value){
  const trimmed=value.trim();
  if (!trimmed) throw new Error('翻訳したいURLを入力してください。');
  const full = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try { const u = new URL(full); if (!['http:','https:'].includes(u.protocol)) throw new Error(); return u.href; }
  catch(_) { throw new Error('URLの形式が正しくありません。'); }
}
async function translatePage(event){
  if (event) event.preventDefault();
  if(state.abort) state.abort.abort();
  const controller=new AbortController(); state.abort=controller;
  clearError(); busy(true); state.translations.clear(); state.run=null; $('continueBtn').hidden=true;
  try {
    const url=normalizeUrl($('urlInput').value);
    $('urlInput').value=url;
    setStatus('Webページを取得しています…', 8);
    const page=await postJson('/api/extract', {url}, controller.signal);
    if (controller.signal.aborted) return;
    if (!page.blocks.length) throw new Error('本文テキストを検出できませんでした。JavaScriptで描画されるサイトの可能性があります。');
    state.page=page; renderReader(page); storeHistory(page.url,page.title);
    const provider=$('provider').value;
    let source=$('sourceLang').value;
    if(source==='auto'){
      const detected=page.detected_language;
      source=(detected==='zh'?'zh-CN':detected);
      if(!LANG_NAMES[source]) source='en';
    }
    const target=$('targetLang').value;
    // blocks that need no translation (code, numbers/symbols only) keep the original text and use no quota
    const pending=[];
    for(const block of page.blocks){
      if(block.type==='image') continue;
      if(block.type==='code' || !/\p{L}/u.test(block.text)) applyTranslation({id:block.id, text:block.text});
      else pending.push(block);
    }
    if(!pending.length) throw new Error('翻訳対象の文章が見つかりませんでした。');
    state.run={source, target, provider, pending};
    await runTranslation(controller);
  } catch(err) {
    if(!isAbort(err)) {clearStatus(); showError(err.message || 'エラーが発生しました。');}
  } finally {
    if(state.abort===controller){state.abort=null;busy(false);clearStatus();}
  }
}
function pickRun(blocks, maxChars){
  // identical texts are translated once, so they count once toward the limit
  const seen=new Set(); const included=[]; let total=0;
  for(const block of blocks){
    const cost=seen.has(block.text)?0:block.text.length;
    if(included.length && total+cost>maxChars) break;
    included.push(block); total+=cost; seen.add(block.text);
  }
  return included;
}
function updateContinueButton(){
  const run=state.run; const btn=$('continueBtn');
  const rest=run?run.pending.length:0;
  btn.hidden=!rest;
  if(rest){
    const chars=run.pending.reduce((n,b)=>n+b.text.length,0);
    $('continueLabel').textContent=`続きを翻訳（残り ${rest} セクション・約${chars.toLocaleString()}文字）`;
  }
}
async function runTranslation(controller){
  const run=state.run; const {source,target,provider}=run;
  const maxChars=provider==='free'?state.freeLimit:state.aiLimit;
  const included=pickRun(run.pending, maxChars);
  run.pending=run.pending.slice(included.length);
  markUntranslated(run.pending.map(b=>b.id), '「続きを翻訳」で翻訳できます');
  $('continueBtn').hidden=true;
  const batches=createBatches(included, provider==='free'?1350:4300, provider==='free'?7:10);
  const parallel=2;
  let complete=0, failed=0, firstError='', quotaHit=null; const retry=[];
  setStatus(`翻訳中 · 0 / ${included.length} セクション`, 18);
  const workers=Array.from({length:Math.min(parallel,batches.length)},async(_,i)=>{
    for(let j=i;j<batches.length;j+=parallel){
      if(controller.signal.aborted) return;
      const batch=batches[j];
      if(quotaHit){ retry.push(...included.filter(b=>batch.some(x=>x.id===b.id))); continue; }
      try {
        const translations=await translateBatch(batch, source, target, provider, controller.signal);
        translations.forEach(applyTranslation);
      } catch(err){
        if(isAbort(err)) return;
        if(err instanceof QuotaError){ quotaHit=err; retry.push(...included.filter(b=>batch.some(x=>x.id===b.id))); continue; }
        failed+=batch.length;
        if(!firstError) firstError=err.message;
        retry.push(...included.filter(b=>batch.some(x=>x.id===b.id)));
        markUntranslated(batch.map(x=>x.id), '翻訳できませんでした（「続きを翻訳」で再試行できます）');
      }
      complete+=batch.length;
      setStatus(`翻訳中 · ${complete} / ${included.length} セクション`, 18+82*(complete/included.length));
    }
  });
  await Promise.all(workers);
  if(controller.signal.aborted) return;
  clearStatus();
  const order=new Map(state.page.blocks.map((b,i)=>[b.id,i]));
  run.pending=retry.concat(run.pending).sort((a,b)=>order.get(a.id)-order.get(b.id));
  if(quotaHit) markUntranslated(retry.map(b=>b.id), '無料翻訳の上限のため未翻訳（「続きを翻訳」で再開できます）');
  const done=state.page.blocks.filter(b=>b.type!=='image' && state.translations.has(b.id)).length;
  $('translatedInfo').textContent=`${done} セクション翻訳済み`;
  updateContinueButton();
  if(quotaHit){showError(`本日の無料翻訳の上限に達しました（${quotaHit.message}）。「無料翻訳の1日の上限を増やす」にメールアドレスを入れると上限が約10倍になります。回復後に「続きを翻訳」で再開できます。`);}
  else if(failed){showError(`${failed} セクションの翻訳に失敗しました。少し待ってから「続きを翻訳」で再試行できます。（${firstError}）`);}
  else if(state.page.truncated){showError('ページが長すぎるため、後半の本文は取得していません。');}
}
async function continueTranslation(){
  if(!state.run || !state.run.pending.length) return;
  if(state.abort) state.abort.abort();
  const controller=new AbortController(); state.abort=controller;
  clearError(); busy(true);
  try { await runTranslation(controller); }
  catch(err){ if(!isAbort(err)) showError(err.message||'エラーが発生しました。'); }
  finally { if(state.abort===controller){state.abort=null;busy(false);clearStatus();} }
}
function translatedText(){
  if(!state.page) return '';
  return `${state.page.title}\n${state.page.url}\n\n`+state.page.blocks.filter(b=>b.type!=='image').map(b=>state.translations.get(b.id)||`[未翻訳] ${b.text}`).join('\n\n');
}
function saveText(){
  if(!state.page) return;
  const blob=new Blob([translatedText()],{type:'text/plain;charset=utf-8'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);
  link.download='weblingo_translation.txt';document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(link.href),250);
}
function setToolLabel(id, icon, label){
  const span=document.createElement('span'); span.textContent=label;
  $(id).replaceChildren(document.createTextNode(`${icon} `), span);
}
async function copyText(){
  if(!state.page)return;
  try{await navigator.clipboard.writeText(translatedText());setToolLabel('copyBtn','✓','コピー済み');setTimeout(()=>setToolLabel('copyBtn','⧉','コピー'),1700);}
  catch(_){showError('クリップボードにコピーできませんでした。HTTPSまたは localhost で利用してください。');}
}
async function init(){
  setTheme((()=>{try{return localStorage.getItem('webLingoTheme')==='dark';}catch(_){return false;}})());
  renderHistory();
  $('translateForm').addEventListener('submit',translatePage);
  $('clearBtn').addEventListener('click',()=>{$('urlInput').value='';$('urlInput').focus();});
  $('dismissError').addEventListener('click',clearError);
  $('themeBtn').addEventListener('click',()=>setTheme(!state.dark));
  $('cancelBtn').addEventListener('click',()=>{if(state.abort)state.abort.abort();markPendingAsCancelled();clearStatus();busy(false);});
  $('swapBtn').addEventListener('click',()=>{
    const oldSource=$('sourceLang').value, oldTarget=$('targetLang').value;
    $('sourceLang').value=oldTarget;
    $('targetLang').value=oldSource==='auto'?'en':oldSource;
  });
  $('provider').addEventListener('change',updateEngineHint);
  $('continueBtn').addEventListener('click',continueTranslation);
  try { $('mmEmail').value=localStorage.getItem('webLingoMyMemoryEmail')||''; } catch(_){}
  $('mmEmail').addEventListener('change',()=>{
    const v=$('mmEmail').value.trim();
    try { v?localStorage.setItem('webLingoMyMemoryEmail',v):localStorage.removeItem('webLingoMyMemoryEmail'); } catch(_){}
    state.quotaUntil=0; updateEngineHint();
  });
  try { const savedTone=localStorage.getItem('webLingoTone'); if(savedTone==='casual'||savedTone==='polite') $('tone').value=savedTone; } catch(_){}
  $('tone').addEventListener('change',()=>{ try{localStorage.setItem('webLingoTone',$('tone').value);}catch(_){} });
  $('copyBtn').addEventListener('click',copyText);
  $('downloadBtn').addEventListener('click',saveText);
  $('sizeBtn').addEventListener('click',()=>{
    state.fontSize=state.fontSize>=18?12:state.fontSize+2;
    document.querySelectorAll('.reading-block:not(.type-heading)').forEach(el=>el.style.fontSize=`${state.fontSize}px`);
  });
  document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
    const name=button.dataset.tab;
    $('readerGrid').dataset.mobileTab=name;
    document.querySelectorAll('[data-tab]').forEach(b=>{const current=b.dataset.tab===name;b.classList.toggle('active',current);b.setAttribute('aria-selected',String(current));});
  }));
  document.querySelectorAll('.demo-link').forEach(b=>b.addEventListener('click',()=>{$('urlInput').value=b.dataset.url;$('translateForm').requestSubmit();}));
  $('clearHistory').addEventListener('click',()=>{try{localStorage.removeItem('webLingoHistory');}catch(_){}renderHistory();});
  try {
    const res=await fetch('/api/status'); if(res.ok){const d=await res.json();state.freeLimit=d.max_free_chars;state.aiLimit=d.max_ai_chars;state.openai=d.openai_available;state.aiRemaining=d.ai_daily_remaining;}
  }catch(_){}
  updateEngineHint();
}
function updateEngineHint(){
  const isAI=$('provider').value==='openai';
  const aiOption=$('provider').querySelector('option[value="openai"]');
  aiOption.textContent=state.openai?'AI翻訳（高品質）':'AI翻訳（未設定）';
  const remain=typeof state.aiRemaining==='number'?` 本日の残り約${state.aiRemaining.toLocaleString()}文字。`:'';
  $('engineHint').textContent=isAI ? (state.openai?`ⓘ AI翻訳が利用できます。${remain}`:'ⓘ AI翻訳はこのサーバーでは利用できません（APIキー未設定または本日の上限到達）。無料翻訳をご利用ください。') : `ⓘ 無料翻訳はMyMemory公開APIを使用します。1回 約${state.freeLimit.toLocaleString()}文字まで（続きも翻訳可）。1日の上限は${myMemoryEmail()?'約50,000':'約5,000'}文字です。`;
}
init();
