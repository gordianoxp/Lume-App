# Organizador Escolar (iPhone)

App de organização escolar: disciplinas, atividades, arquivos, calendário, lembretes, progresso, histórico, modo foco, backup e tema claro/escuro. Em português do Brasil. **v2.1:** foto de perfil (visível só para você e colegas de turma) e créditos. **v2:** contas (Supabase Auth), dados na nuvem com RLS, turmas com mural, sincronização entre aparelhos e cache offline por usuário (IndexedDB). Para configurar: veja **SETUP.md**.

## Estrutura

```
www/                 código do app (HTML + CSS + JavaScript puro, sem build)
  index.html  styles.css  manifest.webmanifest  sw.js
  db.js       cache local por usuário (IndexedDB) + fila de envio
  cloud.js    Supabase: sessão, sincronização, Realtime, arquivos
  auth.js     login/cadastro/recuperação e migração dos dados locais
  classes.js  turmas, mural, agenda individual
  config.js   gerado no build (SUPABASE_URL / SUPABASE_ANON_KEY públicas)
  util.js     estado, datas, ícones, consultas
  notify.js   lembretes (nativo no Xcode / Notification API na web)
  app.js      telas, formulários e ações
  icons/
supabase/migrations/    esquema, RLS, funções, storage
supabase/tests/         testes SQL (PostgreSQL local com shim do Supabase)
tests/integration/      testes no navegador contra backend SIMULADO
netlify.toml  scripts/  build do config.js
capacitor.config.json   configuração do app nativo iOS
package.json            dependências do Capacitor
icon-1024.png           ícone para o Xcode (Assets › AppIcon)
```

## Opção A — instalar sem Mac (PWA, grátis)

Serve para usar já, mas **os lembretes são limitados** (veja "Limitações").

1. Publique a pasta `www/` em qualquer hospedagem HTTPS estática (GitHub Pages, Netlify, Cloudflare Pages…).
2. No iPhone, abra o endereço no **Safari** › botão **Compartilhar** › **Adicionar à Tela de Início**.
3. Abra o app pelo ícone da tela de início (é assim que o iOS libera notificações para PWAs, iOS 16.4 ou superior).

Para testar no computador: `npx serve www` e abra `http://localhost:3000`.

## Opção B — app nativo com lembretes agendados (precisa de Mac + Xcode)

Requisitos: Mac com Xcode 15+, Node 18+, CocoaPods. Com Apple ID gratuito o app instala no seu iPhone por 7 dias; com Apple Developer Program (US$ 99/ano) a instalação dura 1 ano e permite TestFlight/App Store.

```bash
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

No Xcode:

1. Selecione o alvo **App** › **Signing & Capabilities** › escolha seu **Team** e, se necessário, mude o *Bundle Identifier* (ex.: `br.com.seunome.escola`; lembre de igualar o `appId` em `capacitor.config.json`).
2. Em **Assets › AppIcon**, arraste `icon-1024.png`.
3. Conecte o iPhone, selecione-o como destino e clique em **Run**. No iPhone, confie no desenvolvedor em *Ajustes › Geral › VPN e Gerenciamento de Dispositivo*.

Quando mudar algo em `www/`, rode `npx cap sync ios` e execute de novo.

## Limitações (importante)

- **Lembretes na versão web (PWA no iOS):** o Safari não permite agendar notificações locais. O app dispara os lembretes enquanto está aberto/ativo e, ao abrir, avisa os que passaram nas últimas 36 h. Para receber **com o app fechado**, use a Opção B (notificações locais agendadas pelo iOS) ou um servidor de Web Push (não incluído).
- **Armazenamento no Safari:** o iOS pode apagar dados de sites usados pouco (cerca de 7 dias sem abrir, fora da tela de início). Instalado na tela de início ou como app nativo isso não se aplica, mas **faça backups** em *Perfil › Backup completo*.
- **Opção B não foi compilada nem testada aqui** (exige macOS/Xcode). O código nativo-específico (notificações agendadas, abrir/compartilhar arquivos pelo menu do iOS) usa os plugins oficiais do Capacitor e precisa ser validado no seu aparelho.
- Arquivos grandes ocupam o espaço do aparelho; o app avisa se o armazenamento falhar.
- Sincronização exige conexão: offline o app usa o cache e envia as mudanças depois; o chip "Sincronizado/pendente" mostra o estado real.
- Lembretes das atividades vindas de turmas são por usuário e só disparam com o app aberto (ou na Opção B); não há push com o app fechado na web.

## Testes e o que NÃO foi provado
- `bash supabase/tests/run_local.sh`: RLS, funções, storage e limite de tentativas em PostgreSQL 16 real, com um shim do Supabase.
- `bash tests/integration/run_it.sh it_auth.py|it_classes.py|it_avatar.py`: navegador (Chromium) contra backend simulado.
- **Não verificado**: GoTrue/PostgREST/Storage/Realtime reais, entrega de e-mail, CORS, redirect URLs, Safari/iOS. Use a lista de verificação do SETUP.md no seu projeto real.

## Modificando

Tudo está em JavaScript simples. Telas são funções em `VIEWS` (app.js); ações dos botões ficam em `ACT`; consultas e utilitários em `util.js`. Não há etapa de build.
