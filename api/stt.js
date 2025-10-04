// api/stt.js — Vercel Serverless Function (Node.js, não Edge)
// GET /api/stt?yt=<YouTubeID>&lang=pt
import fetch from 'node-fetch';
import ytdl from 'ytdl-core';
import FormData from 'form-data';

export const config = {
  api: {
    bodyParser: false,
    maxDuration: 60 // limite de execução
  }
};

export default async function handler(req, res) {
  try {
    const { yt, lang = 'pt' } = req.query || {};
    if (!yt) return json(res, 400, { ok:false, error:'missing yt' });

    // 1) Obter info e URL de áudio (qualidade mais alta disponível)
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${yt}`);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    if (!format || !format.url) {
      return json(res, 404, { ok:false, error:'no_audio_format' });
    }

    // 2) Baixar áudio com limites de segurança (tamanho/tempo)
    const maxBytes = 25 * 1024 * 1024; // 25 MB
    const audioResp = await fetch(format.url);
    if (!audioResp.ok) {
      return json(res, 502, { ok:false, error:'audio_fetch_failed', status: audioResp.status });
    }

    const reader = audioResp.body.getReader();
    let received = 0;
    const chunks = [];
    const t0 = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        return json(res, 413, { ok:false, error:'audio_too_large', limitMB: maxBytes/1024/1024 });
      }
      if ((Date.now() - t0) / 1000 > 45) {
        return json(res, 504, { ok:false, error:'download_timeout' });
      }
      chunks.push(value);
    }

    const audioBuf = Buffer.concat(chunks);

    // 3) Mandar ao Whisper (OpenAI) pedindo verbose_json (retorna segments)
    const form = new FormData();
    form.append('file', audioBuf, { filename: `${yt}.m4a`, contentType: 'audio/mp4' });
    form.append('model', 'whisper-1');
    form.append('language', lang);
    form.append('response_format', 'verbose_json');

    const sttRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!sttRes.ok) {
      const details = await sttRes.text().catch(()=> '');
      return json(res, 502, { ok:false, error:'whisper_failed', status: sttRes.status, details: details.slice(0,600) });
    }

    const data = await sttRes.json();
    const segments = (data.segments || []).map(s => ({
      start: s.start, end: s.end, text: (s.text || '').trim()
    }));
    const text = segments.map(s=>s.text).join(' ').trim();
    const vtt = buildVTT(segments);

    return json(res, 200, { ok:true, text, segments, vtt });

  } catch (e) {
    return json(res, 500, { ok:false, error:'server_error', details: String(e).slice(0,600) });
  }
}

function buildVTT(segments){
  const toTS = s => {
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const sec = Math.floor(s%60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    const pad = (n,z=2)=>String(n).padStart(z,'0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms,3)}`;
  };
  let out = 'WEBVTT\n\n';
  segments.forEach((seg, i)=>{
    out += `${i+1}\n${toTS(seg.start)} --> ${toTS(seg.end)}\n${seg.text}\n\n`;
  });
  return out;
}

function json(res, status, obj){
  res.status(status);
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  // CORS aberto para você chamar do seu site
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('access-control-allow-headers','authorization,content-type');
  res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
  res.send(JSON.stringify(obj));
}
