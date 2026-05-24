/**
 * Supabase Edge Function — ingestao-rpi
 *
 * Baixa e processa uma RPI do INPI (Revista da Propriedade Industrial),
 * extraindo os processos de marcas e fazendo upsert no banco Supabase.
 *
 * Estrutura XML oficial (v1.02):
 *   <revista numero="2166" data="dd/mm/yyyy">
 *     <processo numero="123456789" data-deposito="dd/mm/yyyy" data-concessao="..." data-vigencia="...">
 *       <despachos>
 *         <despacho codigo="IPAS009" descricao="...">
 *           <texto-complementar>...</texto-complementar>
 *         </despacho>
 *       </despachos>
 *       <titulares>
 *         <titular nome-razao-social="..." pais="BR" uf="SP"/>
 *       </titulares>
 *       <marca apresentacao="Nominativa" natureza="De Produto">
 *         <nome>NOME DA MARCA</nome>
 *       </marca>
 *       <classes-nice>
 *         <classe-nice codigo="25" edicao="10">
 *           <especificacao>...</especificacao>
 *         </classe-nice>
 *       </classes-nice>
 *       <procurador>Nome do Procurador</procurador>
 *     </processo>
 *   </revista>
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4";
import { unzipSync } from "npm:fflate@0.8";

// ── CORS ──────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Parser XML — alinhado com o manual v1.02 do INPI ─────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    ["processo", "despacho", "titular", "classe-nice", "classe-vienna", "sub-classe-nacional", "sobrestador"].includes(name),
  trimValues: true,
  parseTagValue: true,
});

// ── Entry point ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token || token !== Deno.env.get("SERVICE_ROLE_KEY")) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { rpi_numero?: number };
  try { body = await req.json(); } catch { return json({ error: "Body JSON inválido" }, 400); }

  const rpiNumero = Number(body.rpi_numero);
  if (!rpiNumero || isNaN(rpiNumero)) return json({ error: "rpi_numero obrigatório" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SERVICE_ROLE_KEY")!);
  const t0 = Date.now();

  try {
    await registrarImport(sb, rpiNumero, "running", { iniciado_em: new Date().toISOString() });

    const zipBuf = await baixarZip(rpiNumero);
    const { xml, nomeArquivo } = extrairXML(zipBuf);
    console.log(`XML extraído: ${nomeArquivo}`);

    const { processos, rpiData } = parseRevista(xml, rpiNumero);

    // Separa marcas e despachos
    const marcas = processos.map((p) => p.marca).filter((m) => m.processo && m.nome);
    const despachos = processos
      .flatMap((p) => p.despachos)
      .filter((d) => d.processo)
      .map((d) => ({ ...d, rpi_data: rpiData }));

    // Upsert em lotes de 200
    const LOTE = 200;
    for (let i = 0; i < marcas.length; i += LOTE) {
      const { error } = await sb.from("marcas").upsert(marcas.slice(i, i + LOTE), { onConflict: "processo" });
      if (error) throw new Error(`upsert marcas: ${error.message}`);
    }
    for (let i = 0; i < despachos.length; i += LOTE) {
      await sb.from("marcas_despachos").upsert(despachos.slice(i, i + LOTE), {
        onConflict: "processo,rpi_numero,codigo_despacho",
        ignoreDuplicates: true,
      });
    }

    const duracao = Math.round((Date.now() - t0) / 1000);
    console.log(`RPI ${rpiNumero}: ${marcas.length} marcas | ${despachos.length} despachos | ✓ ${duracao}s`);

    await registrarImport(sb, rpiNumero, "done", {
      data_publicacao: rpiData,
      marcas_processadas: marcas.length,
      finalizado_em: new Date().toISOString(),
    });

    return json({ rpi_numero: rpiNumero, marcas: marcas.length, despachos: despachos.length, duracao_s: duracao });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`RPI ${rpiNumero} erro:`, msg);
    await registrarImport(sb, rpiNumero, "error", { erros: { message: msg }, finalizado_em: new Date().toISOString() });
    return json({ error: msg, rpi_numero: rpiNumero }, 500);
  }
});

// ── Download ZIP — testa múltiplos padrões de URL do INPI ────────
async function baixarZip(rpiNumero: number): Promise<Uint8Array> {
  // Padrões conhecidos do INPI (do mais provável ao menos provável)
  const candidatos = [
    `https://revistas.inpi.gov.br/xml/Marcas${rpiNumero}.zip`,
    `https://revistas.inpi.gov.br/xml/marcas${rpiNumero}.zip`,
    `https://revistas.inpi.gov.br/rpi/Marcas${rpiNumero}.zip`,
    `https://revistas.inpi.gov.br/rpi/RPI${rpiNumero}.zip`,
  ];

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/zip, application/octet-stream, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Referer": "https://revistas.inpi.gov.br/rpi",
  };

  for (const url of candidatos) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      const ct = res.headers.get("content-type") ?? "";
      console.log(`${url} → HTTP ${res.status} | ${ct}`);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      // Verifica assinatura ZIP (PK = 0x50 0x4B)
      if (buf[0] === 0x50 && buf[1] === 0x4B) {
        console.log(`✓ ZIP válido: ${url} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
        return buf;
      }
      console.log(`Não é ZIP. Início: ${new TextDecoder().decode(buf.slice(0, 200))}`);
    } catch (e) {
      console.log(`${url} → erro: ${e}`);
    }
  }
  throw new Error(`Nenhuma URL retornou ZIP válido para RPI ${rpiNumero}. Cheque os Logs.`);
}

// ── Extração do XML do ZIP ────────────────────────────────────────
function extrairXML(zipBuf: Uint8Array): { xml: string; nomeArquivo: string } {
  const entries = unzipSync(zipBuf);
  const xmlNomes = Object.keys(entries).filter((n) => n.toLowerCase().endsWith(".xml"));
  if (!xmlNomes.length) throw new Error("Nenhum .xml encontrado no ZIP");

  // Prefere o maior arquivo XML (o de marcas costuma ser o maior)
  const nome = xmlNomes.sort((a, b) => entries[b].length - entries[a].length)[0];
  return { xml: new TextDecoder("utf-8").decode(entries[nome]), nomeArquivo: nome };
}

// ── Parse da revista XML ──────────────────────────────────────────
function parseRevista(xml: string, rpiNumero: number) {
  const doc = xmlParser.parse(xml);
  const revista = (doc.revista ?? doc.Revista) as Record<string, unknown> | undefined;
  if (!revista) throw new Error("Elemento <revista> não encontrado. Tags encontradas: " + Object.keys(doc).join(", "));

  // Data da revista (dd/mm/yyyy → yyyy-mm-dd)
  const rpiData = normalizarData(String(revista["@_data"] ?? ""));

  const processos = toArray<Record<string, unknown>>(
    (revista.processo ?? revista.Processo) as Record<string, unknown>[]
  );
  console.log(`Processos encontrados: ${processos.length}`);

  return {
    rpiData,
    processos: processos.map((p) => extrairDados(p, rpiNumero)),
  };
}

// ── Extração de dados de um processo ─────────────────────────────
function extrairDados(p: Record<string, unknown>, rpiNumero: number) {
  // Número e datas (atributos do <processo>)
  const numero = String(p["@_numero"] ?? "");
  const dataDeposito  = normalizarData(String(p["@_data-deposito"]  ?? p["@_dataDeposito"]  ?? ""));
  const dataConcessao = normalizarData(String(p["@_data-concessao"] ?? p["@_dataConcessao"] ?? ""));
  const dataVigencia  = normalizarData(String(p["@_data-vigencia"]  ?? p["@_dataVigencia"]  ?? ""));

  // <marca apresentacao="..." natureza="..."><nome>...</nome></marca>
  const marcaEl = (p.marca ?? p.Marca ?? {}) as Record<string, unknown>;
  const nome        = String(marcaEl.nome ?? marcaEl.Nome ?? "").trim();
  const apresentacao = String(marcaEl["@_apresentacao"] ?? "");
  const natureza     = String(marcaEl["@_natureza"] ?? "");

  // <titulares><titular nome-razao-social="..." pais="..." uf="..."/></titulares>
  const titularesEl = (p.titulares ?? p.Titulares ?? {}) as Record<string, unknown>;
  const titulares   = toArray<Record<string, unknown>>((titularesEl.titular ?? titularesEl.Titular) as Record<string, unknown>[]);
  const nomeT       = String(titulares[0]?.["@_nome-razao-social"] ?? "").trim();

  // <procurador>Nome</procurador>  (texto direto)
  const procurador = String(p.procurador ?? p.Procurador ?? "").trim();

  // <classes-nice><classe-nice codigo="25" edicao="10"><especificacao>...</especificacao></classe-nice></classes-nice>
  const classesNiceEl = (p["classes-nice"] ?? p.classesNice ?? {}) as Record<string, unknown>;
  const classesNice   = toArray<Record<string, unknown>>((classesNiceEl["classe-nice"] ?? classesNiceEl.classeNice) as Record<string, unknown>[]);
  const classesNcl    = classesNice.map((c) => String(c["@_codigo"] ?? "").trim()).filter(Boolean);
  const especificacao = classesNice.map((c) => String(c.especificacao ?? "")).filter(Boolean).join(" | ");

  // <despachos><despacho codigo="IPAS009" descricao="..."><texto-complementar>...</texto-complementar></despacho></despachos>
  const despachosEl = (p.despachos ?? p.Despachos ?? {}) as Record<string, unknown>;
  const despachos   = toArray<Record<string, unknown>>((despachosEl.despacho ?? despachosEl.Despacho) as Record<string, unknown>[]);

  // Situação determinada pelo código + descrição do último despacho
  const ultimo         = despachos[despachos.length - 1] ?? {};
  const situacaoCodigo = String(ultimo["@_codigo"] ?? "");
  const situacaoDesc   = String(ultimo["@_descricao"] ?? ultimo["texto-complementar"] ?? "");

  const despachoRows = despachos.map((d) => ({
    processo: numero,
    rpi_numero: rpiNumero,
    rpi_data: null as string | null,
    codigo_despacho: String(d["@_codigo"] ?? ""),
    descricao_despacho: String(d["@_descricao"] ?? ""),
    complemento: d["texto-complementar"] ? String(d["texto-complementar"]) : null,
    payload: null,
  }));

  return {
    marca: {
      processo: numero,
      nome,
      tipo: resolverTipo(apresentacao),
      titular: nomeT || null,
      cnpj_cpf: null,          // não está no XML de marcas
      procurador: procurador || null,
      data_deposito:  dataDeposito,
      data_concessao: dataConcessao,
      data_vencimento: dataVigencia,
      situacao: resolverSituacao(situacaoCodigo, situacaoDesc),
      situacao_codigo: situacaoCodigo || null,
      classes_ncl: classesNcl.length ? classesNcl : null,
      especificacao: especificacao || null,
      apresentacao: apresentacao || null,
      natureza: natureza || null,
      tem_imagem: false,
      imagem_url_inpi: null,
      ultima_rpi: rpiNumero,
    },
    despachos: despachoRows,
  };
}

// ── Helpers ───────────────────────────────────────────────────────
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function normalizarData(raw: string): string | null {
  if (!raw || raw === "null") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // dd/mm/yyyy → yyyy-mm-dd
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function resolverTipo(a: string): string | null {
  const l = a.toLowerCase();
  if (l.includes("nominat")) return "Nominativa";
  if (l.includes("figurat")) return "Figurativa";
  if (l.includes("mist"))    return "Mista";
  if (l.includes("tridi"))   return "Tridimensional";
  return a || null;
}

const SITUACAO: Record<string, string> = {
  IPAS001: "Depositada",      IPAS003: "Em exame",
  IPAS004: "Publicada",       IPAS005: "Em exame de mérito",
  IPAS006: "Aguardando pagamento", IPAS007: "Deferida",
  IPAS009: "Publicada para oposição",
  CONC: "Concedida",          CONC001: "Concedida",
  EXT: "Extinta",             EXT001: "Extinta",
  ARQ: "Arquivada",           ARQ001: "Arquivada",
  IND: "Indeferida",          IND001: "Indeferida",
  CADU: "Caducada",           SOB: "Sobrestada",
};

function resolverSituacao(codigo: string, descricao: string): string {
  if (!codigo) return descricao || "Desconhecida";
  if (SITUACAO[codigo]) return SITUACAO[codigo];
  const prefix = Object.keys(SITUACAO).find((k) => codigo.startsWith(k));
  return prefix ? SITUACAO[prefix] : (descricao || codigo);
}

async function registrarImport(sb: ReturnType<typeof createClient>, rpiNumero: number, status: string, dados: Record<string, unknown>) {
  const { error } = await sb.from("rpi_imports").upsert({ rpi_numero: rpiNumero, status, ...dados }, { onConflict: "rpi_numero" });
  if (error) console.warn(`rpi_imports: ${error.message}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
