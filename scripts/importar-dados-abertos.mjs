/**
 * Importa dados de marcas do portal Dados Abertos do INPI
 * https://dadosabertos.inpi.gov.br/index/marcas/
 *
 * Uso:
 *   node importar-dados-abertos.mjs                  # marcas + titular
 *   node importar-dados-abertos.mjs --com-despachos  # + despachos (5.7 GB, lento)
 *
 * Quando INPI_CSV_DIR está definido, lê arquivos locais em vez de baixar da rede.
 * O workflow baixa os CSVs via wget antes de chamar este script.
 *
 * Mapeamento de colunas:
 *   MARCAS_DADOS_BIBLIOGRAFICOS → marcas (processo, nome, tipo, situação, datas)
 *   MARCAS_DEPOSITANTES         → marcas (titular, cnpj_cpf, procurador)
 *   MARCAS_DESPACHOS            → marcas_despachos
 */

import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { createReadStream, existsSync } from "fs";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não definidos.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const BASE = "https://dadosabertos.inpi.gov.br/download/marcas";
const LOTE = 300;
const CSV_DIR = process.env.INPI_CSV_DIR || null;

const args = process.argv.slice(2);
const comDespachos = args.includes("--com-despachos");

// ── Fonte: arquivo local ou URL ───────────────────────────────────
function abrirFonte(nomeArquivo, url) {
  if (CSV_DIR) {
    const caminho = resolve(CSV_DIR, nomeArquivo);
    if (!existsSync(caminho)) throw new Error(`Arquivo não encontrado: ${caminho}`);
    console.log(`  (lendo arquivo local: ${caminho})`);
    return Promise.resolve(createReadStream(caminho));
  }
  return httpGetStream(url);
}

// ── HTTP GET com suporte a redirecionamentos ──────────────────────
function httpGetStream(urlStr, redirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(urlStr, {
      headers: { "User-Agent": "HotMarcas/1.0 (hotmarcas.com.br)" },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        if (redirects <= 0) { reject(new Error("Muitos redirecionamentos")); return; }
        const loc = new URL(res.headers.location, urlStr).toString();
        httpGetStream(loc, redirects - 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.setTimeout(1_800_000, () => req.destroy(new Error("timeout: sem dados por 30min")));
    req.on("error", reject);
  });
}

// ── Stream + upsert genérico ──────────────────────────────────────
async function streamCSV(label, nomeArquivo, url, mapRow, onBatch) {
  console.log(`\n▶ ${label}`);
  const source = await abrirFonte(nomeArquivo, url);

  // Verifica statusCode apenas para respostas HTTP (não para ReadStream local)
  if (source.statusCode !== undefined && source.statusCode !== 200) {
    source.destroy();
    throw new Error(`HTTP ${source.statusCode} em ${url}`);
  }

  const parser = parse({ columns: true, trim: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  source.on("error", (err) => { if (!parser.destroyed) parser.destroy(err); });
  source.pipe(parser);

  let batch = [], total = 0, erros = 0;
  const t0 = Date.now();

  try {
    for await (const row of parser) {
      const mapped = mapRow(row);
      if (!mapped) continue;
      batch.push(mapped);

      if (batch.length >= LOTE) {
        try {
          await onBatch(batch);
          total += batch.length;
        } catch (e) {
          console.error(`  ⚠ erro no lote ~${total}: ${e.message}`);
          erros++;
        }
        batch = [];
        if (total % 100_000 === 0) {
          const s = Math.round((Date.now() - t0) / 1000);
          console.log(`  ${total.toLocaleString()} linhas... (${s}s)`);
        }
      }
    }
  } finally {
    if (!source.destroyed) source.destroy();
  }

  if (batch.length > 0) {
    try { await onBatch(batch); total += batch.length; }
    catch (e) { erros++; }
  }

  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`  ✓ ${total.toLocaleString()} linhas | ${erros} erros | ${s}s`);
  return { total, erros };
}

// Retry só faz sentido quando lendo da rede; com arquivo local, não é necessário
async function streamCSVComRetry(label, nomeArquivo, url, mapRow, onBatch, maxRetries = 5) {
  const tentativas = CSV_DIR ? 1 : maxRetries;
  for (let attempt = 1; attempt <= tentativas; attempt++) {
    try {
      return await streamCSV(label, nomeArquivo, url, mapRow, onBatch);
    } catch (e) {
      if (attempt === tentativas) throw e;
      const espera = attempt * 15;
      console.error(`  ↺ conexão perdida (tentativa ${attempt}/${tentativas}): ${e.message}`);
      console.error(`  aguardando ${espera}s antes de reconectar...`);
      await new Promise(r => setTimeout(r, espera * 1000));
    }
  }
}

// ── Helper tipo ───────────────────────────────────────────────────
function resolverTipo(a) {
  const l = (a ?? "").toLowerCase();
  if (l.includes("nominat")) return "Nominativa";
  if (l.includes("figurat")) return "Figurativa";
  if (l.includes("mist"))    return "Mista";
  if (l.includes("tridi"))   return "Tridimensional";
  return a || null;
}

// ── Fase 1: Dados Bibliográficos → marcas ─────────────────────────
await streamCSVComRetry(
  "MARCAS_DADOS_BIBLIOGRAFICOS → marcas",
  "MARCAS_DADOS_BIBLIOGRAFICOS.csv",
  `${BASE}/MARCAS_DADOS_BIBLIOGRAFICOS.csv`,
  (row) => {
    const nome = (row.elemento_nominativo ?? "").trim();
    if (!nome || !row.numero_inpi) return null;
    const ap = (row.descricao_apresentacao ?? "").trim();
    return {
      processo:        row.numero_inpi.trim(),
      nome,
      apresentacao:    ap || null,
      natureza:        (row.descricao_natureza ?? "").trim() || null,
      tipo:            resolverTipo(ap),
      data_deposito:   row.data_deposito   || null,
      data_concessao:  row.data_concessao  || null,
      data_vencimento: row.data_vigencia   || null,
      situacao:        (row.descricao_situacao ?? "").trim() || null,
      situacao_codigo: (row.codigo_situacao ?? "").trim()    || null,
      tem_imagem:      false,
      imagem_url_inpi: null,
    };
  },
  async (batch) => {
    const { error } = await sb.from("marcas").upsert(batch, { onConflict: "processo" });
    if (error) throw new Error(error.message);
  }
);

// ── Fase 2: Depositantes → titular, cnpj, procurador ─────────────
await streamCSVComRetry(
  "MARCAS_DEPOSITANTES → titular",
  "MARCAS_DEPOSITANTES.csv",
  `${BASE}/MARCAS_DEPOSITANTES.csv`,
  (row) => {
    if (!row.numero_inpi) return null;
    return {
      processo:   row.numero_inpi.trim(),
      titular:    (row.nome ?? "").trim() || null,
      cnpj_cpf:   (row.cnpj_cpf_titular ?? "").trim() || null,
      procurador: (row.nome_representante_legal ?? "").trim() || null,
    };
  },
  async (batch) => {
    const { error } = await sb.from("marcas").upsert(batch, { onConflict: "processo" });
    if (error) throw new Error(error.message);
  }
);

// ── Fase 3: Despachos (opcional) ──────────────────────────────────
if (comDespachos) {
  await streamCSVComRetry(
    "MARCAS_DESPACHOS → marcas_despachos",
    "MARCAS_DESPACHOS.csv",
    `${BASE}/MARCAS_DESPACHOS.csv`,
    (row) => {
      if (!row.numero_inpi || !row.numero_rpi) return null;
      const cod = (row.codigo_despacho ?? "").trim();
      if (!cod) return null;
      return {
        processo:           row.numero_inpi.trim(),
        rpi_numero:         parseInt(row.numero_rpi) || null,
        rpi_data:           row.data_rpi || null,
        codigo_despacho:    cod,
        descricao_despacho: (row.descricao_despacho ?? "").trim() || null,
        complemento:        (row.complemento_despacho ?? "").trim() || null,
        payload:            null,
      };
    },
    async (batch) => {
      await sb.from("marcas_despachos").upsert(batch, {
        onConflict: "processo,rpi_numero,codigo_despacho",
        ignoreDuplicates: true,
      });
    }
  );
}

console.log("\n=== Importação concluída ===");
