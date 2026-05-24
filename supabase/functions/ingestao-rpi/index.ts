/**
 * Supabase Edge Function — ingestao-rpi
 *
 * Baixa e processa um único arquivo RPI do INPI, fazendo upsert no banco.
 * Roda na infraestrutura Deno/Cloudflare do Supabase (IPs não bloqueados pelo INPI).
 *
 * POST /functions/v1/ingestao-rpi
 * Authorization: Bearer <service_role_key>
 * Body: { "rpi_numero": 2870 }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4";
import { unzipSync } from "npm:fflate@0.8";

// ── CORS ──────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Parser XML ────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    ["processo", "despacho", "classeNCL", "classe-nice", "classeViena"].includes(name),
  trimValues: true,
});

// ── Entry point ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Valida token
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY");
  if (!token || token !== serviceKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { rpi_numero?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON inválido" }, 400);
  }

  const rpiNumero = Number(body.rpi_numero);
  if (!rpiNumero || isNaN(rpiNumero)) {
    return json({ error: "rpi_numero obrigatório (número inteiro)" }, 400);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SERVICE_ROLE_KEY")!,
  );

  const t0 = Date.now();

  try {
    await registrarImport(sb, rpiNumero, "running", { iniciado_em: new Date().toISOString() });

    // 1. Download do ZIP
    const zipBuf = await baixarZip(rpiNumero);

    // 2. Extração do XML em memória
    const xml = extrairXML(zipBuf);

    // 3. Parsing
    const processos = extrairProcessos(xml, rpiNumero);

    // 4. Extrai data da RPI
    let rpiDataStr: string | null = null;
    try {
      const doc = xmlParser.parse(xml);
      const rpi = doc.RPI || doc.rpi || Object.values(doc)[0];
      rpiDataStr = (rpi as Record<string, unknown>)?.["@_data"] as string ?? null;
    } catch { /* ignora */ }

    // 5. Upsert em lotes de 200
    const marcas = processos.map((p) => p.marca).filter((m) => m.processo);
    const despachos = processos
      .flatMap((p) => p.despachos)
      .filter((d) => d.processo)
      .map((d) => ({ ...d, rpi_data: rpiDataStr }));

    const LOTE = 200;
    for (let i = 0; i < marcas.length; i += LOTE) {
      const { error } = await sb.from("marcas").upsert(marcas.slice(i, i + LOTE), { onConflict: "processo" });
      if (error) throw new Error(`Upsert marcas: ${error.message}`);
    }
    for (let i = 0; i < despachos.length; i += LOTE) {
      await sb.from("marcas_despachos").upsert(despachos.slice(i, i + LOTE), {
        onConflict: "processo,rpi_numero,codigo_despacho",
        ignoreDuplicates: true,
      });
    }

    const duracao = Math.round((Date.now() - t0) / 1000);

    await registrarImport(sb, rpiNumero, "done", {
      data_publicacao: rpiDataStr,
      marcas_processadas: marcas.length,
      finalizado_em: new Date().toISOString(),
    });

    console.log(`RPI ${rpiNumero}: ${marcas.length} marcas | ${despachos.length} despachos | ✓ ${duracao}s`);

    return json({ rpi_numero: rpiNumero, marcas: marcas.length, despachos: despachos.length, duracao_s: duracao });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`RPI ${rpiNumero} erro:`, msg);
    await registrarImport(sb, rpiNumero, "error", {
      erros: { message: msg },
      finalizado_em: new Date().toISOString(),
    });
    return json({ error: msg, rpi_numero: rpiNumero }, 500);
  }
});

// ── Helpers HTTP ──────────────────────────────────────────────────
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Download ZIP ──────────────────────────────────────────────────
async function baixarZip(rpiNumero: number): Promise<Uint8Array> {
  const url = `https://revistas.inpi.gov.br/rpi/RPI${rpiNumero}.zip`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/zip, application/octet-stream, */*",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Referer": "https://revistas.inpi.gov.br/",
    },
    signal: AbortSignal.timeout(120_000),
  });
  const contentType = res.headers.get("content-type") ?? "desconhecido";
  const finalUrl = res.url;
  console.log(`INPI HTTP ${res.status} | content-type: ${contentType} | url final: ${finalUrl}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar RPI ${rpiNumero}`);
  const buf = await res.arrayBuffer();
  // Verifica assinatura ZIP (bytes PK = 0x50 0x4B)
  const first4 = new Uint8Array(buf.slice(0, 4));
  console.log(`Primeiros bytes: ${Array.from(first4).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
  if (first4[0] !== 0x50 || first4[1] !== 0x4B) {
    // Loga início do conteúdo para diagnóstico
    const preview = new TextDecoder().decode(buf.slice(0, 300));
    console.error(`Conteúdo não é ZIP. Preview: ${preview}`);
    throw new Error(`Resposta não é um ZIP válido (HTTP ${res.status}, content-type: ${contentType}). Preview: ${preview.slice(0, 120)}`);
  }
  return new Uint8Array(buf);
}

// ── Extração do XML do ZIP ────────────────────────────────────────
function extrairXML(zipBuf: Uint8Array): string {
  const entries = unzipSync(zipBuf);
  const nomes = Object.keys(entries).filter((n) => n.toLowerCase().endsWith(".xml"));
  if (!nomes.length) throw new Error("Nenhum XML no ZIP");

  // Prefere arquivo com "marca" no nome; senão usa o maior
  const nome = nomes.find((n) => /marca/i.test(n)) ??
    nomes.sort((a, b) => entries[b].length - entries[a].length)[0];

  return new TextDecoder("utf-8").decode(entries[nome]);
}

// ── Parsing de processos ──────────────────────────────────────────
function extrairProcessos(xml: string, rpiNumero: number) {
  const doc = xmlParser.parse(xml);
  const rpi = doc.RPI ?? doc.rpi ?? Object.values(doc)[0] as Record<string, unknown>;
  const container = (rpi?.marcas ?? rpi?.Marcas ?? rpi) as Record<string, unknown>;
  const processos = toArray(container?.processo ?? container?.Processo ?? []);
  return processos.map((p) => extrairDados(p as Record<string, unknown>, rpiNumero));
}

function toArray<T>(val: T | T[]): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extrairDados(p: Record<string, unknown>, rpiNumero: number) {
  const numero = String(p["@_numero"] ?? p["@_Numero"] ?? "");
  const marca = (p.marca ?? p.Marca ?? {}) as Record<string, unknown>;
  const titular = (p.titular ?? p.Titular ?? {}) as Record<string, unknown>;
  const procObj = (p.procurador ?? p.Procurador ?? {}) as Record<string, unknown>;

  const classesRaw = toArray<Record<string, unknown>>(
    (p.classeNCL ?? p["classe-nice"] ?? p.ClasseNCL ?? []) as Record<string, unknown>[],
  );
  const classesNcl = classesRaw
    .map((c) => String(c["@_codigo"] ?? c["@_Codigo"] ?? "").trim())
    .filter(Boolean);

  const especificacao = classesRaw
    .map((c) => c.especificacao ?? c.Especificacao ?? "")
    .filter(Boolean)
    .join(" | ");

  const despachos = toArray<Record<string, unknown>>(
    (p.despacho ?? p.Despacho ?? []) as Record<string, unknown>[],
  );
  const ultimoDespacho = despachos[despachos.length - 1] ?? {};
  const situacaoCodigo = String(ultimoDespacho["@_codigo"] ?? ultimoDespacho["@_Codigo"] ?? "");
  const textoDespacho = String(ultimoDespacho.texto ?? ultimoDespacho.Texto ?? "");

  const imgEl = (p.imagem ?? p.Imagem) as Record<string, unknown> | undefined;
  const nomeArq = imgEl ? String(imgEl["@_nome-arquivo"] ?? imgEl["@_nomeArquivo"] ?? "") : "";

  const despachoRows = despachos.map((d) => ({
    processo: numero,
    rpi_numero: rpiNumero,
    rpi_data: null as string | null,
    codigo_despacho: String(d["@_codigo"] ?? d["@_Codigo"] ?? ""),
    descricao_despacho: String(d.texto ?? d.Texto ?? ""),
    complemento: d.complemento ?? d.Complemento ?? null,
    payload: null,
  }));

  return {
    marca: {
      processo: numero,
      nome: String(marca.nome ?? marca.Nome ?? p.nome ?? ""),
      tipo: resolverTipo(String(marca.apresentacao ?? marca.Apresentacao ?? "")),
      titular: String(titular["nome-razao-social"] ?? titular.nome ?? titular.Nome ?? ""),
      cnpj_cpf: String(titular.cnpj ?? titular.cpf ?? titular["cnpj-cpf"] ?? "") || null,
      procurador: String(procObj.nome ?? procObj.Nome ?? "") || null,
      data_deposito: normalizarData(String(p["data-deposito"] ?? p.dataDeposito ?? "")),
      situacao: resolverSituacao(situacaoCodigo, textoDespacho),
      situacao_codigo: situacaoCodigo || null,
      classes_ncl: classesNcl.length ? classesNcl : null,
      especificacao: especificacao || null,
      apresentacao: String(marca.apresentacao ?? marca.Apresentacao ?? "") || null,
      natureza: String(marca.natureza ?? marca.Natureza ?? "") || null,
      tem_imagem: !!imgEl,
      imagem_url_inpi: nomeArq ? `https://revistas.inpi.gov.br/rpi/imagens/${nomeArq}` : null,
      ultima_rpi: rpiNumero,
    },
    despachos: despachoRows,
  };
}

// ── Normalização ──────────────────────────────────────────────────
function normalizarData(raw: string): string | null {
  if (!raw || raw === "null") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function resolverTipo(a: string): string | null {
  const l = a.toLowerCase();
  if (l.includes("nominat")) return "Nominativa";
  if (l.includes("figurat")) return "Figurativa";
  if (l.includes("mist")) return "Mista";
  if (l.includes("tridi")) return "Tridimensional";
  return a || null;
}

const SITUACAO: Record<string, string> = {
  IPAS001: "Depositada", IPAS003: "Em exame", IPAS004: "Publicada para oposição",
  IPAS005: "Em exame de mérito", IPAS006: "Aguardando pagamento", IPAS007: "Deferida",
  CONC: "Concedida", CONC001: "Concedida", EXT: "Extinta", EXT001: "Extinta",
  ARQ: "Arquivada", ARQ001: "Arquivada", IND: "Indeferida", IND001: "Indeferida",
  CADU: "Caducada", SOB: "Sobrestada", EXIG: "Exigência formulada",
};

function resolverSituacao(codigo: string, texto: string): string {
  if (!codigo) return texto || "Desconhecida";
  if (SITUACAO[codigo]) return SITUACAO[codigo];
  const prefix = Object.keys(SITUACAO).find((k) => codigo.startsWith(k));
  return prefix ? SITUACAO[prefix] : (texto || codigo);
}

// ── Registro de importação ────────────────────────────────────────
async function registrarImport(
  sb: ReturnType<typeof createClient>,
  rpiNumero: number,
  status: string,
  dados: Record<string, unknown>,
) {
  const { error } = await sb.from("rpi_imports").upsert(
    { rpi_numero: rpiNumero, status, ...dados },
    { onConflict: "rpi_numero" },
  );
  if (error) console.warn(`rpi_imports warning: ${error.message}`);
}
