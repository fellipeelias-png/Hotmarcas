/**
 * Ingestão de RPIs do INPI para o Supabase
 *
 * Uso: node ingestao-rpi.mjs --inicio 2870 --fim 2820
 * O range é processado do mais recente ao mais antigo.
 *
 * Variáveis de ambiente (lidas de ../.env ou de process.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import AdmZip from 'adm-zip';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Carrega .env da raiz do repo (um nível acima de scripts/)
const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dir, '../.env') });

// ──────────────────────────────────────────────
// Configuração
// ──────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const INPI_RPI_URL = (n) => `https://revistas.inpi.gov.br/rpi/RPI${n}.zip`;
const LOTE_SIZE = 200; // marcas por upsert batch
const RETRY_MAX = 3;
const RETRY_DELAY_MS = [2000, 4000, 8000];

// ──────────────────────────────────────────────
// Parser XML
// ──────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['processo', 'despacho', 'classeNCL', 'classe-nice', 'classeViena'].includes(name),
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

// ──────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let inicio = null, fim = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inicio') inicio = parseInt(args[i + 1], 10);
    if (args[i] === '--fim') fim = parseInt(args[i + 1], 10);
  }
  if (!inicio || !fim) {
    console.error('Uso: node ingestao-rpi.mjs --inicio 2870 --fim 2820');
    process.exit(1);
  }
  return { inicio, fim };
}

// ──────────────────────────────────────────────
// Download e extração do ZIP
// ──────────────────────────────────────────────

async function baixarZip(rpiNumero) {
  const url = INPI_RPI_URL(rpiNumero);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

function extrairXML(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Heurística: prefere arquivo com "marca" no nome; senão, o maior XML
  const xmlEntries = entries.filter(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntries.length) throw new Error('Nenhum XML encontrado no ZIP');

  const comMarca = xmlEntries.find(e => /marca/i.test(e.entryName));
  const entrada = comMarca || xmlEntries.sort((a, b) => b.header.size - a.header.size)[0];

  return entrada.getData().toString('utf-8');
}

// ──────────────────────────────────────────────
// Parsing de processos no XML
// ──────────────────────────────────────────────

function extrairProcessos(xml, rpiNumero) {
  const doc = xmlParser.parse(xml);

  // O XML pode ter raiz <RPI> ou outras variações
  const rpi = doc.RPI || doc.rpi || Object.values(doc)[0];
  if (!rpi) throw new Error('Raiz XML não reconhecida');

  // Processos podem estar em diferentes caminhos
  const marcasContainer = rpi.marcas || rpi.Marcas || rpi;
  const processos = toArray(marcasContainer?.processo || marcasContainer?.Processo || []);

  return processos.map(p => extrairDadosProcesso(p, rpiNumero));
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extrairDadosProcesso(p, rpiNumero) {
  const numero = p['@_numero'] || p['@_Numero'] || '';

  // Dados da marca
  const marca = p.marca || p.Marca || {};
  const nome = marca.nome || marca.Nome || p.nome || '';
  const apresentacao = marca.apresentacao || marca.Apresentacao || '';
  const natureza = marca.natureza || marca.Natureza || '';

  // Titular
  const titular = p.titular || p.Titular || {};
  const nomeT = titular['nome-razao-social'] || titular.nome || titular.Nome || '';
  const cnpjCpf = titular.cnpj || titular.cpf || titular['cnpj-cpf'] || '';

  // Procurador
  const procObj = p.procurador || p.Procurador || {};
  const procurador = procObj.nome || procObj.Nome || '';

  // Classes NCL — podem aparecer como classeNCL ou classe-nice
  const classesRaw = toArray(p.classeNCL || p['classe-nice'] || p.ClasseNCL || []);
  const classesNcl = classesRaw
    .map(c => String(c['@_codigo'] || c['@_Codigo'] || '').trim())
    .filter(Boolean);

  // Especificação (usa a primeira classe, ou concatena todas)
  const especificacao = classesRaw
    .map(c => c.especificacao || c.Especificacao || '')
    .filter(Boolean)
    .join(' | ');

  // Data de depósito
  const dataDeposito = p['data-deposito'] || p['dataDeposito'] || p['@_dataDeposito'] || null;

  // Despachos — determina situação pelo despacho mais recente
  const despachos = toArray(p.despacho || p.Despacho || []);
  const ultimoDespacho = despachos[despachos.length - 1] || {};
  const situacaoCodigo = ultimoDespacho['@_codigo'] || ultimoDespacho['@_Codigo'] || '';
  const situacao = resolverSituacao(situacaoCodigo, ultimoDespacho.texto || ultimoDespacho.Texto || '');

  // Imagem
  const imgEl = p.imagem || p.Imagem || null;
  const temImagem = !!imgEl;
  const nomeArquivo = imgEl ? (imgEl['@_nome-arquivo'] || imgEl['@_nomeArquivo'] || '') : '';
  const imagemUrlInpi = nomeArquivo
    ? `https://revistas.inpi.gov.br/rpi/imagens/${nomeArquivo}`
    : null;

  // Monta objeto de despachos para inserção
  const despachoRows = despachos.map(d => ({
    processo: numero,
    rpi_numero: rpiNumero,
    rpi_data: null, // será preenchido abaixo com a data da RPI
    codigo_despacho: d['@_codigo'] || d['@_Codigo'] || '',
    descricao_despacho: d.texto || d.Texto || '',
    complemento: d.complemento || d.Complemento || null,
    payload: Object.keys(d).length > 3 ? d : null,
  }));

  return {
    marca: {
      processo: numero,
      nome,
      tipo: resolverTipo(apresentacao),
      titular: nomeT,
      cnpj_cpf: cnpjCpf,
      procurador: procurador || null,
      data_deposito: normalizarData(dataDeposito),
      situacao,
      situacao_codigo: situacaoCodigo || null,
      classes_ncl: classesNcl.length ? classesNcl : null,
      especificacao: especificacao || null,
      apresentacao: apresentacao || null,
      natureza: natureza || null,
      tem_imagem: temImagem,
      imagem_url_inpi: imagemUrlInpi,
      ultima_rpi: rpiNumero,
    },
    despachos: despachoRows,
  };
}

// ──────────────────────────────────────────────
// Helpers de normalização
// ──────────────────────────────────────────────

function normalizarData(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Aceita YYYY-MM-DD ou DD/MM/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function resolverTipo(apresentacao) {
  const a = (apresentacao || '').toLowerCase();
  if (a.includes('nominat')) return 'Nominativa';
  if (a.includes('figurat')) return 'Figurativa';
  if (a.includes('mist')) return 'Mista';
  if (a.includes('tridi')) return 'Tridimensional';
  return apresentacao || null;
}

// Mapeamento de códigos de despacho para situação legível
const DESPACHO_SITUACAO = {
  IPAS001: 'Depositada',
  CONC: 'Concedida',
  CONC001: 'Concedida',
  EXT: 'Extinta',
  EXT001: 'Extinta',
  ARQ: 'Arquivada',
  ARQ001: 'Arquivada',
  IND: 'Indeferida',
  IND001: 'Indeferida',
  CADU: 'Caducada',
  SOB: 'Sobrestada',
  EXIG: 'Exigência formulada',
  IPAS003: 'Em exame',
  IPAS004: 'Publicada para oposição',
  IPAS005: 'Em exame de mérito',
  IPAS006: 'Aguardando pagamento',
  IPAS007: 'Deferida',
};

function resolverSituacao(codigo, texto) {
  if (!codigo) return texto || 'Desconhecida';
  // Tenta match exato, depois prefixo
  if (DESPACHO_SITUACAO[codigo]) return DESPACHO_SITUACAO[codigo];
  const prefix = Object.keys(DESPACHO_SITUACAO).find(k => codigo.startsWith(k));
  if (prefix) return DESPACHO_SITUACAO[prefix];
  return texto || codigo;
}

// ──────────────────────────────────────────────
// Upsert no Supabase
// ──────────────────────────────────────────────

async function upsertMarcas(marcas) {
  const { error } = await supabase
    .from('marcas')
    .upsert(marcas, { onConflict: 'processo' });
  if (error) throw error;
}

async function insertDespachos(despachos) {
  if (!despachos.length) return;
  const { error } = await supabase
    .from('marcas_despachos')
    .upsert(despachos, { onConflict: 'processo,rpi_numero,codigo_despacho', ignoreDuplicates: true });
  if (error) throw error;
}

async function registrarImport(rpiNumero, status, dados) {
  const { error } = await supabase
    .from('rpi_imports')
    .upsert({ rpi_numero: rpiNumero, status, ...dados }, { onConflict: 'rpi_numero' });
  if (error) console.warn(`⚠ Falha ao registrar rpi_imports para RPI ${rpiNumero}:`, error.message);
}

// ──────────────────────────────────────────────
// Processamento de uma RPI com retry
// ──────────────────────────────────────────────

async function processarRPI(rpiNumero) {
  await registrarImport(rpiNumero, 'running', { iniciado_em: new Date().toISOString() });
  const inicio = Date.now();

  for (let tentativa = 0; tentativa <= RETRY_MAX; tentativa++) {
    try {
      // Download e parsing
      const zipBuf = await baixarZip(rpiNumero);
      const xml = extrairXML(zipBuf);
      const processos = extrairProcessos(xml, rpiNumero);

      // Extrai data da RPI do XML (para preencher rpi_data dos despachos)
      let rpiDataStr = null;
      try {
        const doc = xmlParser.parse(xml);
        const rpi = doc.RPI || doc.rpi || Object.values(doc)[0];
        rpiDataStr = rpi?.['@_data'] || null;
      } catch (_) {}

      // Separa marcas e despachos
      const marcasRows = processos.map(p => p.marca).filter(m => m.processo);
      const despachosRows = processos
        .flatMap(p => p.despachos)
        .filter(d => d.processo)
        .map(d => ({ ...d, rpi_data: rpiDataStr }));

      // Upsert em lotes
      for (let i = 0; i < marcasRows.length; i += LOTE_SIZE) {
        await upsertMarcas(marcasRows.slice(i, i + LOTE_SIZE));
      }
      for (let i = 0; i < despachosRows.length; i += LOTE_SIZE) {
        await insertDespachos(despachosRows.slice(i, i + LOTE_SIZE));
      }

      const duracao = ((Date.now() - inicio) / 1000).toFixed(0);
      console.log(`RPI ${rpiNumero}: ${marcasRows.length.toLocaleString()} marcas | ${despachosRows.length.toLocaleString()} despachos | ✓ ${duracao}s`);

      await registrarImport(rpiNumero, 'done', {
        data_publicacao: rpiDataStr,
        marcas_processadas: marcasRows.length,
        finalizado_em: new Date().toISOString(),
      });

      return { marcas: marcasRows.length, despachos: despachosRows.length, erro: null };
    } catch (err) {
      if (tentativa < RETRY_MAX) {
        const delay = RETRY_DELAY_MS[tentativa];
        console.warn(`  ↺ RPI ${rpiNumero}: tentativa ${tentativa + 1} falhou — aguardando ${delay / 1000}s... (${err.message})`);
        await sleep(delay);
      } else {
        console.error(`  ✗ RPI ${rpiNumero}: falhou após ${RETRY_MAX + 1} tentativas — ${err.message}`);
        await registrarImport(rpiNumero, 'error', {
          erros: { message: err.message, stack: err.stack?.slice(0, 500) },
          finalizado_em: new Date().toISOString(),
        });
        return { marcas: 0, despachos: 0, erro: err.message };
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  const { inicio, fim } = parseArgs();

  console.log(`\n🔍 Ingestão HotMarcas — RPI ${inicio} → ${fim}`);
  console.log(`   Supabase: ${SUPABASE_URL}\n`);

  const inicioTotal = Date.now();
  let totalMarcas = 0, totalDespachos = 0, totalErros = 0;

  // Itera do mais recente ao mais antigo
  const step = inicio >= fim ? -1 : 1;
  for (let rpi = inicio; step === -1 ? rpi >= fim : rpi <= fim; rpi += step) {
    const resultado = await processarRPI(rpi);
    totalMarcas += resultado.marcas;
    totalDespachos += resultado.despachos;
    if (resultado.erro) totalErros++;
  }

  const duracaoTotal = ((Date.now() - inicioTotal) / 1000).toFixed(0);
  const totalRpis = Math.abs(inicio - fim) + 1;

  console.log(`\n✅ Concluído em ${duracaoTotal}s`);
  console.log(`   RPIs processadas: ${totalRpis - totalErros}/${totalRpis}`);
  console.log(`   Marcas inseridas/atualizadas: ${totalMarcas.toLocaleString()}`);
  console.log(`   Despachos inseridos: ${totalDespachos.toLocaleString()}`);
  if (totalErros) console.log(`   ⚠ RPIs com erro: ${totalErros}`);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
