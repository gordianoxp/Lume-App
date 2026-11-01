/* Configuração do servidor de contas (Supabase).
   Estes dois valores são PÚBLICOS por definição: a segurança dos dados vem das políticas RLS do banco.
   Use a chave "anon" (ou "publishable"). NUNCA coloque aqui a chave "service_role".
   No Netlify, o build preenche este arquivo a partir das variáveis SUPABASE_URL e SUPABASE_ANON_KEY
   (veja SETUP.md). Se você publica arrastando a pasta, edite os valores abaixo. */
window.APP_CONFIG = {
  supabaseUrl: 'https://lfzfcthgyxyvbsjibuqd.supabase.co/rest/v1/,
  supabaseAnonKey: 'https://lfzfcthgyxyvbsjibuqd.supabase.co/rest/v1/'
};
