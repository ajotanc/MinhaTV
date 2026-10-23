# Alexa → Android TV (Mi Box 4K)

Controle uma Mi Box 4K (ou outra Android TV) por voz com a Alexa, como num Fire Stick: abrir e fechar apps, abrir um filme, série ou episódio direto no Netflix, Prime Video, Disney+ e Globoplay, tocar no YouTube e no Spotify, volume, pausar, avançar e voltar.

```
Echo → Alexa (skill custom) → seu endpoint HTTPS → container Node/TypeScript → ADB pela rede local → Android TV
```

Sem AWS Lambda e sem nada pago: a skill é uma "custom skill" com endpoint HTTPS próprio, que este projeto serve.

> **Idioma:** o modelo de voz é em **Português (Brasil)**. Para outro idioma é preciso traduzir `skill/interaction-model.json` e as falas em `src/server.ts`.

## O que faz

- **Apps:** "abrir Netflix", "fechar Netflix".
- **Títulos:** "assistir Matrix" (escolhe o serviço pela ordem de `SERVICE_PRIORITY`) ou "assistir Matrix na Netflix". Os links vêm do JustWatch.
- **Episódios:** "assistir The Boys temporada 1 episódio 2" (Prime e Disney+; na Netflix só abre a série).
- **YouTube** (API oficial): "assistir gatinhos no YouTube". Evita Shorts e vídeos de mais de 30 min, a menos que o pedido diga "hora", "completo" ou "ao vivo".
- **Spotify** (API oficial, não precisa de Premium): "tocar Bohemian Rhapsody no Spotify".
- **Controle:** volume (com contagem), mudo, pausar, continuar, voltar, início, ligar/desligar, "avançar 30 segundos", "voltar 10 segundos".
- **Perfil:** escolhe o perfil mais recente sozinha no Prime, Disney+ e Globoplay (detecção por captura de tela em memória; nada é gravado em disco).
- **Troca de conteúdo sem reabrir:** se o app já está aberto, só troca o título. Fechar e reabrir só acontece ao trocar de app (e na Netflix).
- **Resiliência:** acorda a TV do standby, reconecta o ADB e, se o IP da TV mudar, varre a rede até achá-la.
- **Lista de títulos:** mantém no modelo da skill os títulos mais populares do momento, para a Alexa entendê-los melhor, atualizada sozinha toda semana.

## Requisitos

- Android TV com **Depuração USB** (ADB por rede), na mesma rede do servidor.
- Uma máquina sempre ligada com **Docker** (PC, NAS, Raspberry Pi…).
- Um endereço **HTTPS público** para a Alexa chegar no container. Um [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) é a forma mais simples e gratuita; qualquer proxy reverso com certificado válido serve.
- Conta de desenvolvedor Amazon (gratuita): [developer.amazon.com/alexa/console/ask](https://developer.amazon.com/alexa/console/ask).
- Opcional: chave da YouTube Data API e app do Spotify (ambos gratuitos).

## Instalação

### 1. Android TV

Configurações → Sobre → clique 7 vezes em "Build" → Opções do desenvolvedor → ativar **Depuração USB**. Anote o IP e reserve-o para a TV no roteador (DHCP por MAC). Se o IP mudar mesmo assim, o serviço varre `TV_SUBNET` na porta 5555 e acha a TV; `TV_MODEL` evita confundi-la com outro aparelho com ADB.

### 2. Configuração

```bash
git clone <este-repositorio> alexa-tv && cd alexa-tv
cp .env.example .env
```

Edite o `.env`:

| Variável | Para quê |
|---|---|
| `TV_HOST` | IP da TV com porta (`192.168.1.50:5555`); opcional se `TV_SUBNET` estiver definido |
| `TV_SUBNET` | rede a varrer se a TV mudar de IP (`192.168.1.0/24`) |
| `TV_MODEL` | trecho do modelo da TV (`adb shell getprop ro.product.model`) |
| `SERVICE_PRIORITY` | ordem quando você não diz o app (`prime,disney,netflix`) |
| `YOUTUBE_API_KEY` | console.cloud.google.com → ativar "YouTube Data API v3" → chave de API (cota grátis de ~100 buscas/dia) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | developer.spotify.com/dashboard → Create app |
| `SKILL_ID` | id da sua skill (passo 4); recusa pedidos de qualquer outra skill |
| `TEST_TOKEN` | segredo longo que protege `/cmd` e `/health`; **obrigatório trocar** |
| `AUTO_TITLES` / `TITLES_PACKAGES` | atualização semanal da lista de títulos e os serviços usados (`prv` Prime, `dnp` Disney+, `nfx` Netflix, `gop` Globoplay, `mxx` HBO Max) |

### 3. Subir o container

```bash
docker compose up -d --build
```

Na primeira vez a TV mostra "Permitir depuração USB?": marque **Sempre permitir**. A autorização fica no volume `adbkeys`. O serviço escuta na porta 3333 do host.

Exponha-o em HTTPS. Com Cloudflare Tunnel: Zero Trust → Tunnels → seu túnel → Public hostnames → um hostname dedicado (ex.: `alexa.seudominio.com`) apontando para o serviço **HTTP** do container. Se o `cloudflared` roda em Docker, ponha-o na mesma rede do container e use `http://alexa-tv:3000`; `localhost` não serve, pois dentro do `cloudflared` ele é o próprio `cloudflared`. **Não** coloque Cloudflare Access nem desafio de bot nesse hostname: a Alexa precisa chegar nele.

### 4. Criar a skill

1. [Console de desenvolvedor](https://developer.amazon.com/alexa/console/ask) → Create Skill → Português (BR), **Custom**, **Provision your own**, **Start from scratch**.
2. Build → Interaction Model → **JSON Editor**: cole `skill/interaction-model.json` → Save → **Build skill**.
3. Build → Endpoint → **HTTPS**: Default Region `https://alexa.seudominio.com/` (a raiz; `/alexa` também funciona), certificado "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority" → Save → **Build skill** de novo.
4. Copie o Skill ID (`amzn1.ask.skill.…`) para `SKILL_ID` no `.env` e rode `docker compose up -d`.
5. Test → **Development**. No simulador: "abrir minha t. v." e depois "assistir Matrix". Funciona nos Echos logados na mesma conta, com o idioma em Português (Brasil).

O nome de invocação é `minha t. v.` (a Alexa escreve "tv" como "t. v."; com `minha tv` a skill não era chamada). Para mudar, edite `invocationName` no modelo.

## Como pedir

A Alexa só entrega o pedido à skill se ouvir o nome dela, mas o nome pode vir **no fim** da frase e dispensa abrir conversa antes:

- "Alexa, assistir The Boys temporada 1 episódio 2 na minha tê vê"
- "Alexa, pausar usando minha tê vê"
- "Alexa, peça à minha tê vê para tocar Queen no Spotify"
- "Alexa, abrir minha t. v." e depois comandos seguidos sem repetir o nome (a sessão fica aberta ~16 s entre comandos).

Exemplos: "assistir Matrix na Netflix", "abrir Disney", "aumentar o volume 10 vezes", "pausar", "continuar", "voltar", "avançar 30 segundos", "fechar Netflix", "assistir gatinhos no YouTube".

Frases ainda mais curtas ("Netflix", "modo cinema") são possíveis com Rotinas do app Alexa, mas dão trabalho manual; este projeto funciona só pela skill.

## Testar sem Alexa

```bash
curl -X POST https://alexa.seudominio.com/cmd -H "x-token: SEU_TOKEN" -H "content-type: application/json" \
  -d '{"action":"play","app":"netflix","q":"matrix"}'
curl https://alexa.seudominio.com/health -H "x-token: SEU_TOKEN"
```

Ações do `/cmd`: `open`, `close` (com `app`), `play` (`q`; `app`, `season`, `episode` opcionais), `search` (`app`, `q`), `key` (`key`, `times`), `focus` (janela em foco), `titles` (atualiza a lista agora). `/health` mostra se a TV está conectada e acordada. Os logs (`docker compose logs -f`) mostram cada comando ADB e o que a Alexa entendeu.

## Lista de títulos

A Alexa transcreve mal títulos em inglês quando eles vêm como texto livre. Por isso o modelo tem um slot `TITLE` (usado pelo `WatchIntent`) com os títulos mais populares do Brasil nos serviços de `TITLES_PACKAGES`, mais os seus favoritos em `skill/titles-extra.txt` (um por linha: `Título em português | Título original`). Fora da lista, o texto livre continua valendo.

Com `AUTO_TITLES=1`, uma vez por semana o container busca a lista no JustWatch, monta o modelo e o envia ao console pelo **ASK CLI**, esperando o build. Isso exige autorizar o ASK CLI uma vez:

```bash
docker compose run --rm -it alexa-tv ask configure   # responda NÃO ao passo da AWS
```

O token fica na pasta `ask/` (montada em `/root/.ask`). Ele vale para **todas** as suas skills: não compartilhe nem comite essa pasta. Sem ele, desligue `AUTO_TITLES` e rode `npm run titles` para gerar o modelo à mão. Também dá para buscar o modelo do dia em `/model.json`.

## Configurar apps e perfis

Tudo fica em `src/apps.ts` (um registro `apps`). Para um app novo, descubra o pacote com `adb shell pm list packages | grep -i nome` e adicione uma entrada. Campos principais:

- `pkg` e `search` (deep link com `{q}`; `null` usa a busca global do Android TV).
- `forceStop`: fecha antes de abrir o link (a Netflix ignora links com o app aberto).
- `profilePicker` (`'vertical'` ou `'horizontal'`), `profileKeys`, `profileEveryLaunch`: seletor de perfil por captura de tela. Para um app novo o detector em `src/screen.ts` precisa ser calibrado.
- `profileActivity` e `profileSettle`: seletor que é uma activity própria (Globoplay).
- `linkQuery`: parâmetro extra nos links de título (no Prime, `autoplay=1` evita parar na página de detalhes).
- `resolve`: acha o conteúdo por API própria (YouTube, Spotify).

O seletor de perfil escolhe o último usado; se outra pessoa usar outro perfil, a próxima abertura cai nele. Perfil com PIN para na tela do PIN. As teclas de mídia e o tempo de avanço ficam em `KEYS` de `src/tv.ts`.

## Segurança

- **Esta é uma skill de desenvolvimento, para uso pessoal.** Ela não autentica quem fala: qualquer Echo da sua conta controla a TV. Não publique a skill na loja da Alexa sem antes acrescentar uma lista de usuários permitidos.
- O endpoint é público. A assinatura e o timestamp das requisições da Alexa são verificados (`ask-sdk-express-adapter`), `SKILL_ID` recusa outras skills, e `/cmd` e `/health` exigem `TEST_TOKEN`. Use um token longo e aleatório.
- ADB sem autenticação além da chave aceita na TV: mantenha a porta 5555 só na rede local.
- Nunca comite `.env`, `ask/` ou `data/` (já estão no `.gitignore`).

## Limitações conhecidas

- **JustWatch é uma API não oficial.** Se mudar, o ajuste fica em `src/justwatch.ts`. Os links são cacheados por 7 dias.
- **Netflix não foi testada** (sem conta durante o desenvolvimento); só abre a série, não o episódio.
- **Avançar/voltar é aproximado:** usa teclas de mídia (~10 s por toque). Medido só no YouTube; Prime e Disney+ podem variar.
- Calibrações de perfil medidas em Mi Box 4K com Android TV 9; outras versões dos apps ou aparelhos podem exigir ajuste.
- A Mi Box 4K tem 2 GB de RAM e o Wi-Fi dela costuma perder pacotes: prefira 5 GHz ou cabo, e não deixe o `scrcpy` aberto.
- A Alexa desiste da skill em ~8 s; se a TV demorar mais, ela ouve "Já estou cuidando disso" e o comando segue em segundo plano.
- Apps com DRM devolvem captura de tela preta, então o detector de perfil só funciona nos seletores, que não são protegidos.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test          # testes do parser de pedidos, planos do JustWatch, detector de perfil e lista de títulos
npm run build && npm start
```

Estrutura: `src/server.ts` (skill e endpoints), `src/tv.ts` (ADB), `src/apps.ts` (apps e parser), `src/justwatch.ts`, `src/youtube.ts`, `src/spotify.ts`, `src/screen.ts` (detector de perfil), `src/titles.ts` e `src/model-update.ts` (lista de títulos), `skill/` (modelo de interação).

Contribuições são bem-vindas, principalmente calibrações de outros apps e aparelhos. Adicione uma licença (`LICENSE`) antes de publicar.
