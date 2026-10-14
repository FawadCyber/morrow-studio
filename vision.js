// Leather jacket check with CLIP, running inside the dashboard (CPU, no Python, no extra port).
// CLIP compares each photo with written descriptions; the closest description wins.
const STYLES = ['biker', 'bomber', 'trucker', 'cafe racer', 'aviator shearling', 'blazer style', 'suede', 'puffer', 'other'];
const COLORS = ['black', 'brown', 'tan', 'cognac', 'burgundy', 'red', 'white', 'green', 'blue', 'grey', 'beige'];
const POS = [
  'a photo of a person wearing a short leather jacket',
  'a celebrity wearing a leather jacket',
  'a waist length leather biker jacket',
  'a leather bomber jacket'
];
const NEG = [
  'a long leather coat reaching the thighs or knees',
  'a leather car coat',
  'a tailored leather blazer with lapels',
  'a person wearing a suit or tuxedo',
  'a denim jacket',
  'a puffer jacket',
  'a wool coat',
  'a person wearing a hoodie, sweater or t-shirt',
  'a person wearing a dress'
];
// Extra "not this" descriptions for news photos (celebrity looks), which are noisier than product shots
const NEG_NEWS = [
  'a close-up portrait of a face',
  'a man wearing a navy cloth jacket or wool coat',
  'a person wearing a cotton or nylon jacket',
  'a concert stage photo with colored lights',
  'football players on a sports pitch',
  'a politician giving a speech',
  'a poster or graphic with text',
  'a group of people at an event'
];
const MODEL = 'Xenova/clip-vit-base-patch32';

let ready = null;
function load() {
  if (ready) return ready;
  ready = (async () => {
    const T = await import('@huggingface/transformers');
    // Model files (~600 MB) live in the user's home folder, outside the project
    T.env.cacheDir = process.env.MODEL_CACHE || require('path').join(require('os').homedir(), '.leather-hunt', 'models');
    const tokenizer = await T.AutoTokenizer.from_pretrained(MODEL);
    const textModel = await T.CLIPTextModelWithProjection.from_pretrained(MODEL);
    const processor = await T.AutoProcessor.from_pretrained(MODEL);
    const visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL);
    const embedText = async prompts => {
      const { text_embeds } = await textModel(tokenizer(prompts, { padding: true, truncation: true }));
      return rows(text_embeds);
    };
    return {
      T, processor, visionModel,
      leather: await embedText([...POS, ...NEG]),
      leatherNews: await embedText([...POS, ...NEG, ...NEG_NEWS]),
      styles: await embedText(STYLES.map(s => `a ${s} leather jacket`)),
      colors: await embedText(COLORS.map(c => `a ${c} leather jacket`))
    };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// tensor [n, d] -> array of unit-length vectors
function rows(t) {
  const [n, d] = t.dims;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = Array.from(t.data.slice(i * d, (i + 1) * d));
    const norm = Math.hypot(...v) || 1;
    out.push(v.map(x => x / norm));
  }
  return out;
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
function softmax(scores) {
  const m = Math.max(...scores);
  const e = scores.map(s => Math.exp((s - m) * 100));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / sum);
}
const argmax = scores => scores.indexOf(Math.max(...scores));

// The photo's CLIP "fingerprint" (512 numbers, unit length). Used for taste learning, photo search and duplicates.
async function embed(source) {
  const m = await load();
  let image;
  if (/^https?:\/\//i.test(String(source))) {
    const r = await fetch(source, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 MorrowStudio' } });
    if (!r.ok) throw new Error('Photo download failed: HTTP ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > 15e6) throw new Error('Photo too large');
    const blob = await r.blob();
    if (blob.size > 15e6) throw new Error('Photo too large');
    image = await m.T.RawImage.fromBlob(blob);
  } else image = await m.T.RawImage.read(source);
  const { image_embeds } = await m.visionModel(await m.processor(image));
  return rows(image_embeds)[0];
}

// source: an http(s) URL or a local file path. news: true for news / celebrity photos (stricter)
async function check(source, { news = false } = {}) {
  const m = await load();
  const v = await embed(source);
  const p = softmax((news ? m.leatherNews : m.leather).map(t => dot(t, v)));
  const confidence = p.slice(0, POS.length).reduce((a, b) => a + b, 0);
  return {
    is_leather_jacket: confidence >= 0.5,
    confidence: Math.round(confidence * 1000) / 1000,
    style: STYLES[argmax(m.styles.map(t => dot(t, v)))],
    color: COLORS[argmax(m.colors.map(t => dot(t, v)))],
    embedding: v
  };
}

// Bump when the descriptions change: saved jackets get checked again
const VERSION = 2;

module.exports = { check, embed, load, VERSION };
