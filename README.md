# HotMarcas

Site de registro de marcas no INPI. HTML/CSS/JS puro, hospedado na Vercel.

---

## Busca de Marcas INPI

A funcionalidade de busca exige um projeto Supabase com a base de dados do INPI importada via script de ingestão.

### 1. Criar o projeto Supabase e rodar a migration

1. Acesse [app.supabase.com](https://app.supabase.com) e crie um novo projeto.
2. Vá em **SQL Editor** e cole o conteúdo de `supabase/migrations/001_schema.sql`.
3. Clique em **Run** — isso cria as tabelas, índices, trigger e função de busca.

### 2. Configurar os secrets no GitHub

No repositório GitHub, vá em **Settings > Secrets and variables > Actions** e adicione:

| Secret | Valor |
|--------|-------|
| `SUPABASE_URL` | URL do projeto (ex: `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (aba API do projeto) |

### 3. Disparar a ingestão histórica

Para importar as últimas 52 RPIs (aprox. 1 ano de dados):

1. Vá em **Actions > Ingestão Histórica RPI > Run workflow**.
2. Informe:
   - **RPI início:** número da RPI mais recente (ex: `2870`)
   - **RPI fim:** número da RPI mais antiga desejada (ex: `2820`)
3. Clique em **Run workflow** e acompanhe o log.

Para rodar localmente:
```bash
cd scripts
cp ../.env.example ../.env   # preencha com seus valores reais
npm install
npm run ingerir -- --inicio 2870 --fim 2870
```

### 4. Configurar variáveis no Vercel

No painel do projeto Vercel, vá em **Settings > Environment Variables** e adicione:

| Variável | Valor |
|----------|-------|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Anon key (aba API do projeto) |

> A anon key é pública e segura para o frontend — o acesso é controlado por Row Level Security (RLS) no Supabase.

### 5. Ativar as páginas de busca

Após configurar o Supabase, edite os dois arquivos abaixo e substitua os placeholders pelas chaves reais:

**`buscar-marcas/index.html`** (linha ~270):
```js
const SUPABASE_URL  = 'https://SEU-PROJETO.supabase.co';   // ← substitua
const SUPABASE_ANON = 'sua-anon-key-aqui';                  // ← substitua
```

**`marca/index.html`** (linha ~260):
```js
const SUPABASE_URL  = 'https://SEU-PROJETO.supabase.co';   // ← substitua
const SUPABASE_ANON = 'sua-anon-key-aqui';                  // ← substitua
```

Após editar, faça commit e push — o deploy na Vercel é automático.

As páginas estarão disponíveis em:
- `/buscar-marcas` — busca por nome, classe e situação
- `/marca/?p={numero}` — detalhe completo do processo
