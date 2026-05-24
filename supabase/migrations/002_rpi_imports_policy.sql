-- Permite que o service role faça leitura e escrita em rpi_imports
-- (a tabela já tem RLS habilitado; o service role precisa de policy explícita
--  quando chamado via Edge Function com createClient usando a service_role key)
CREATE POLICY "service_role_rpi_imports" ON rpi_imports
  FOR ALL
  USING (true)
  WITH CHECK (true);
