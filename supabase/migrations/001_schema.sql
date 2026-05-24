-- Extensões necessárias para busca fonética, trigrama e sem acento
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Tabela principal de marcas
CREATE TABLE marcas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  processo text UNIQUE NOT NULL,
  nome text NOT NULL,
  nome_normalizado text,
  nome_metaphone text,
  nome_tsv tsvector,
  tipo text,
  titular text,
  cnpj_cpf text,
  procurador text,
  data_deposito date,
  data_concessao date,
  data_vencimento date,
  situacao text,
  situacao_codigo text,
  classes_ncl text[],
  especificacao text,
  apresentacao text,
  natureza text,
  tem_imagem boolean DEFAULT false,
  imagem_url_inpi text,
  ultima_rpi integer,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Histórico de despachos por processo
CREATE TABLE marcas_despachos (
  id bigserial PRIMARY KEY,
  processo text NOT NULL,
  rpi_numero integer NOT NULL,
  rpi_data date NOT NULL,
  codigo_despacho text,
  descricao_despacho text,
  complemento text,
  payload jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(processo, rpi_numero, codigo_despacho)
);

-- Controle de importações de RPI
CREATE TABLE rpi_imports (
  rpi_numero integer PRIMARY KEY,
  data_publicacao date,
  status text DEFAULT 'pending',
  marcas_processadas integer DEFAULT 0,
  erros jsonb,
  iniciado_em timestamptz,
  finalizado_em timestamptz
);

-- Índices para busca eficiente
CREATE INDEX idx_marcas_nome_tsv ON marcas USING GIN(nome_tsv);
CREATE INDEX idx_marcas_nome_trgm ON marcas USING GIN(nome_normalizado gin_trgm_ops);
CREATE INDEX idx_marcas_metaphone ON marcas(nome_metaphone);
CREATE INDEX idx_marcas_situacao ON marcas(situacao);
CREATE INDEX idx_marcas_classes ON marcas USING GIN(classes_ncl);
CREATE INDEX idx_marcas_processo ON marcas(processo);
CREATE INDEX idx_marcas_titular ON marcas(titular);
CREATE INDEX idx_despachos_processo ON marcas_despachos(processo);

-- Trigger que atualiza campos normalizados antes de cada INSERT/UPDATE
CREATE OR REPLACE FUNCTION atualizar_campos_busca()
RETURNS trigger AS $$
BEGIN
  NEW.nome_normalizado := lower(unaccent(NEW.nome));
  NEW.nome_tsv := to_tsvector('portuguese', unaccent(NEW.nome));
  NEW.nome_metaphone := metaphone(unaccent(NEW.nome), 10);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_campos_busca
BEFORE INSERT OR UPDATE ON marcas
FOR EACH ROW EXECUTE FUNCTION atualizar_campos_busca();

-- Função principal de busca com score composto (exata + full-text + trigramas + fonética)
CREATE OR REPLACE FUNCTION buscar_marca(
  p_termo text,
  p_classes text[] DEFAULT NULL,
  p_situacao text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, processo text, nome text, titular text,
  situacao text, classes_ncl text[], data_deposito date,
  tem_imagem boolean, imagem_url_inpi text, score numeric
) AS $$
DECLARE
  v_norm text := lower(unaccent(p_termo));
  v_meta text := metaphone(unaccent(p_termo), 10);
BEGIN
  RETURN QUERY
  SELECT m.id, m.processo, m.nome, m.titular, m.situacao,
         m.classes_ncl, m.data_deposito, m.tem_imagem, m.imagem_url_inpi,
    (
      CASE WHEN m.nome_normalizado = v_norm THEN 100 ELSE 0 END +
      CASE WHEN m.nome_tsv @@ plainto_tsquery('portuguese', unaccent(p_termo))
           THEN ts_rank(m.nome_tsv, plainto_tsquery('portuguese', unaccent(p_termo))) * 70
           ELSE 0 END +
      similarity(m.nome_normalizado, v_norm) * 50 +
      CASE WHEN m.nome_metaphone = v_meta THEN 30 ELSE 0 END
    )::numeric AS score
  FROM marcas m
  WHERE (
    m.nome_normalizado = v_norm OR
    m.nome_tsv @@ plainto_tsquery('portuguese', unaccent(p_termo)) OR
    similarity(m.nome_normalizado, v_norm) > 0.3 OR
    m.nome_metaphone = v_meta
  )
  AND (p_classes IS NULL OR m.classes_ncl && p_classes)
  AND (p_situacao IS NULL OR m.situacao = p_situacao)
  ORDER BY score DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;

-- RLS: leitura pública, escrita apenas via service role
ALTER TABLE marcas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "marcas_publicas" ON marcas FOR SELECT USING (true);

ALTER TABLE marcas_despachos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "despachos_publicos" ON marcas_despachos FOR SELECT USING (true);
