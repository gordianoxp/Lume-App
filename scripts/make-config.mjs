// Gera www/config.js a partir das variáveis de ambiente do Netlify (SUPABASE_URL, SUPABASE_ANON_KEY).
// Se as variáveis não existirem, mantém o config.js atual (e avisa). Nunca grava a chave service_role.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'www', 'config.js');
const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!url || !key) {
  const cur = readFileSync(file, 'utf8');
  const filled = /supabaseUrl:\s*'[^']+'/.test(cur) && /supabaseAnonKey:\s*'[^']+'/.test(cur);
  console.warn(filled
    ? '[config] Variáveis SUPABASE_* ausentes: mantendo os valores já presentes em www/config.js.'
    : '[config] ATENÇÃO: defina SUPABASE_URL e SUPABASE_ANON_KEY no Netlify (ou edite www/config.js). O app mostrará "Configuração pendente".');
  process.exit(0);
}
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) { console.error('[config] SUPABASE_URL inválida (esperado https://xxxx.supabase.co).'); process.exit(1); }
if (/service_role/i.test(key) || (key.split('.').length === 3 && /"role"\s*:\s*"service_role"/.test(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')))) {
  console.error('[config] RECUSADO: esta chave parece ser a service_role (secreta). Use a chave "anon"/"publishable".');
  process.exit(1);
}
writeFileSync(file, `/* Gerado no build a partir das variáveis de ambiente. */\nwindow.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2)};\n`);
console.log('[config] www/config.js gerado.');
