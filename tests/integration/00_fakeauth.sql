-- Somente para o teste de integração: contas do servidor de autenticação SIMULADO (não existe no Supabase real).
create schema if not exists fakeauth;
create table if not exists fakeauth.accounts (
  id        uuid primary key,
  email     text unique not null,
  password  text not null,
  confirmed boolean not null default false,
  name      text not null default ''
);
