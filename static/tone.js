'use strict';
/*
 * Japanese tone adjuster for free (MyMemory) translations.
 * MyMemory output is mostly polite (です・ます). This turns sentence-final polite
 * endings into a natural conversational plain style. Only safe, unambiguous
 * patterns are converted; anything uncertain is left as-is.
 */
(function (root) {
  // sentence end: punctuation, closing brackets, whitespace or end of text
  const END = '(?=[。．.！!？?」』）)\\]〉》\\s]|$)';
  const PARTICLE = '(よね|ね|よ)?';

  // [polite stem before ます, dictionary, past, negative]
  const GODAN = [
    ['思い','思う','思った','思わない'], ['言い','言う','言った','言わない'], ['使い','使う','使った','使わない'],
    ['行い','行う','行った','行わない'], ['扱い','扱う','扱った','扱わない'], ['伴い','伴う','伴った','伴わない'],
    ['従い','従う','従った','従わない'], ['違い','違う','違った','違わない'], ['会い','会う','会った','会わない'],
    ['買い','買う','買った','買わない'], ['払い','払う','払った','払わない'], ['手伝い','手伝う','手伝った','手伝わない'],
    ['向かい','向かう','向かった','向かわない'], ['願い','願う','願った','願わない'], ['もらい','もらう','もらった','もらわない'],
    ['書き','書く','書いた','書かない'], ['働き','働く','働いた','働かない'], ['動き','動く','動いた','動かない'],
    ['続き','続く','続いた','続かない'], ['開き','開く','開いた','開かない'], ['届き','届く','届いた','届かない'],
    ['聞き','聞く','聞いた','聞かない'], ['置き','置く','置いた','置かない'], ['行き','行く','行った','行かない'],
    ['急ぎ','急ぐ','急いだ','急がない'], ['泳ぎ','泳ぐ','泳いだ','泳がない'],
    ['話し','話す','話した','話さない'], ['示し','示す','示した','示さない'], ['出し','出す','出した','出さない'],
    ['返し','返す','返した','返さない'], ['渡し','渡す','渡した','渡さない'], ['表し','表す','表した','表さない'],
    ['探し','探す','探した','探さない'], ['残し','残す','残した','残さない'], ['指し','指す','指した','指さない'],
    ['持ち','持つ','持った','持たない'], ['待ち','待つ','待った','待たない'], ['立ち','立つ','立った','立たない'],
    ['役立ち','役立つ','役立った','役立たない'], ['勝ち','勝つ','勝った','勝たない'],
    ['読み','読む','読んだ','読まない'], ['含み','含む','含んだ','含まない'], ['進み','進む','進んだ','進まない'],
    ['住み','住む','住んだ','住まない'], ['楽しみ','楽しむ','楽しんだ','楽しまない'], ['望み','望む','望んだ','望まない'],
    ['選び','選ぶ','選んだ','選ばない'], ['呼び','呼ぶ','呼んだ','呼ばない'], ['学び','学ぶ','学んだ','学ばない'],
    ['遊び','遊ぶ','遊んだ','遊ばない'], ['結び','結ぶ','結んだ','結ばない'], ['死に','死ぬ','死んだ','死なない'],
    ['取り','取る','取った','取らない'], ['作り','作る','作った','作らない'], ['始まり','始まる','始まった','始まらない'],
    ['変わり','変わる','変わった','変わらない'], ['終わり','終わる','終わった','終わらない'], ['分かり','分かる','分かった','分からない'],
    ['わかり','わかる','わかった','わからない'], ['守り','守る','守った','守らない'], ['送り','送る','送った','送らない'],
    ['残り','残る','残った','残らない'], ['入り','入る','入った','入らない'], ['帰り','帰る','帰った','帰らない'],
    ['走り','走る','走った','走らない'], ['見つかり','見つかる','見つかった','見つからない'], ['かかり','かかる','かかった','かからない'],
    ['集まり','集まる','集まった','集まらない'], ['決まり','決まる','決まった','決まらない'], ['なり','なる','なった','ならない'],
    ['知り','知る','知った','知らない'], ['頑張り','頑張る','頑張った','頑張らない'], ['がんばり','がんばる','がんばった','がんばらない'],
    ['あり','ある','あった','ない'], ['でき','できる','できた','できない'], ['来','来る','来た','来ない'],
    ['見','見る','見た','見ない'], ['出','出る','出た','出ない'], ['寝','寝る','寝た','寝ない'], ['い','いる','いた','いない'],
  ];
  // stems matched only when the previous char is not a kanji / ざ (e.g. 言い, ございます)
  const NEEDS_BOUNDARY = new Set(['い', '見', '出', '来']);
  const E_ROW = 'えけげせぜてでねへべぺめれ';

  function negPast(neg) { return neg.replace(/い$/, 'かった'); }
  function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  const RULES = [];
  function rule(pattern, replacement) { RULES.push([new RegExp(pattern + PARTICLE + END, 'g'), replacement]); }

  // copula / auxiliary endings (longest first)
  rule('ではありませんでした', 'ではなかった$1');
  rule('じゃありませんでした', 'じゃなかった$1');
  rule('ではありません', 'ではない$1');
  rule('じゃありません', 'じゃない$1');
  rule('でしょうか', 'だろうか$1');
  rule('でしょう', 'だろう$1');
  rule('なのでしょうか', 'なんだろう$1');
  rule('なのです', 'なんだ$1');
  rule('のです', 'んだ$1');
  rule('のでした', 'んだった$1');
  RULES.push([new RegExp('いですか[？?]?' + END, 'g'), 'いの？']);
  RULES.push([new RegExp('ですか[？?]?' + END, 'g'), 'なの？']);
  rule('(?<!ません)でした', 'だった$1');
  rule('いです', 'い$1');
  rule('です', 'だ$1');
  // request: 〜してください -> 〜して
  RULES.push([new RegExp('([てで])(?:下さい|ください)' + END, 'g'), '$1']);
  RULES.push([new RegExp('([てで])(?:下さい|ください)ね' + END, 'g'), '$1ね']);
  // しましょう -> しよう
  rule('しましょう', 'しよう$1');

  // verb + ます family from the explicit list
  for (const [stem, dict, past, neg] of GODAN) {
    const guard = NEEDS_BOUNDARY.has(stem) ? '(?<![\\u4e00-\\u9fffざ])' : '';
    const s = guard + escape(stem);
    rule(s + 'ませんでした', negPast(neg) + '$1');
    rule(s + 'ません', neg + '$1');
    rule(s + 'ました', past + '$1');
    rule(s + 'ます', dict + '$1');
  }
  // ichidan: e-row kana + ます (食べます, 考えます, 使われます, 見せます …)
  const ER = `([${E_ROW}])`;
  RULES.push([new RegExp(ER + 'ませんでした' + PARTICLE + END, 'g'), '$1なかった$2']);
  RULES.push([new RegExp(ER + 'ません' + PARTICLE + END, 'g'), '$1ない$2']);
  RULES.push([new RegExp(ER + 'ました' + PARTICLE + END, 'g'), '$1た$2']);
  RULES.push([new RegExp(ER + 'ます' + PARTICLE + END, 'g'), '$1る$2']);
  RULES.push([new RegExp(ER + 'ましょう' + PARTICLE + END, 'g'), '$1よう$2']); // 始めましょう -> 始めよう
  // suru verbs: 使用します / 確認しました (only after kanji/katakana or the hiragana と/に/を/く)
  const SURU = '([\\u4e00-\\u9fff\\u30a0-\\u30ffとにをくう])し';
  RULES.push([new RegExp(SURU + 'ませんでした' + PARTICLE + END, 'g'), '$1しなかった$2']);
  RULES.push([new RegExp(SURU + 'ません' + PARTICLE + END, 'g'), '$1しない$2']);
  RULES.push([new RegExp(SURU + 'ました' + PARTICLE + END, 'g'), '$1した$2']);
  RULES.push([new RegExp(SURU + 'ます' + PARTICLE + END, 'g'), '$1する$2']);

  function toCasualJa(text) {
    if (!text || !/(です|ます|でした|ました|ません|でしょう|ましょう|ください)/.test(text)) return text;
    let out = text;
    for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
    return out;
  }

  root.toCasualJa = toCasualJa;
  if (typeof module !== 'undefined' && module.exports) module.exports = { toCasualJa };
})(typeof window !== 'undefined' ? window : globalThis);
