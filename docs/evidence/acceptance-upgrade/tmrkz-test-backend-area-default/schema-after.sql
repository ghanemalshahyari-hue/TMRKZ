--
-- PostgreSQL database dump
--

\restrict 5UhU6R7yyibO3Dm9uztKTeSQa6Rx39OsILlTdohiBEJ9ZGouT81uosIiLcjelRl

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: postgis_raster; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis_raster WITH SCHEMA public;


--
-- Name: EXTENSION postgis_raster; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis_raster IS 'PostGIS raster types and functions';


--
-- Name: access_policy_version_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.access_policy_version_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'policy versions are never deleted' using errcode = 'P0001';
  end if;
  if old.status <> 'DRAFT' and (new.roles is distinct from old.roles or new.version <> old.version) then
    raise exception 'published policy versions are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;


--
-- Name: authz_note_person(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authz_note_person() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  pid uuid;
begin
  if tg_table_name = 'membership' then
    pid := coalesce(new.person_id, old.person_id);
  elsif tg_table_name = 'delegation' then
    pid := coalesce(new.delegate_id, old.delegate_id);
  elsif tg_table_name = 'membership_scope_target' then
    select person_id into pid from membership where id = coalesce(new.membership_id, old.membership_id);
  end if;
  insert into authz_change(person_id, source) values (pid, tg_table_name);
  return null;
end $$;


--
-- Name: authz_note_shared(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authz_note_shared() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into authz_change(person_id, source) values (null, tg_table_name || ':' || tg_argv[0]);
  return null;
end $$;


--
-- Name: hr_mapping_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hr_mapping_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status <> 'DRAFT' then
    if new.fields is distinct from old.fields or new.active_rules is distinct from old.active_rules
        or new.discovered_columns is distinct from old.discovered_columns
        or new.version <> old.version or new.source_id <> old.source_id then
      raise exception 'published HR mapping versions are immutable' using errcode = '23514';
    end if;
    if new.status <> old.status and not (old.status = 'PUBLISHED' and new.status = 'SUPERSEDED') then
      raise exception 'published HR mapping versions are immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;


--
-- Name: membership_scope_target_frozen(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.membership_scope_target_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'scope targets are fixed once granted; end the grant and create a new one' using errcode = 'P0001';
end $$;


--
-- Name: mover_forbid_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mover_forbid_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception '% rows are append-only (attempted %)', tg_table_name, tg_op using errcode = '42501';
end $$;


--
-- Name: mover_forbid_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mover_forbid_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception '% rows cannot be deleted; retire them instead', tg_table_name using errcode = '42501';
end $$;


--
-- Name: mover_published_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mover_published_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'published % cannot be deleted', tg_table_name using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'DRAFT' then
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
       or not (new.status = old.status or (old.status = 'PUBLISHED' and new.status = 'RETIRED')) then
      raise exception 'published % is immutable', tg_table_name using errcode = '42501';
    end if;
  end if;
  return new;
end $$;


--
-- Name: organization_hr_read_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.organization_hr_read_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.source = 'HR' and coalesce(current_setting('tmrkz.hr_projection', true), '') <> 'on'
     and (new.name is distinct from old.name or new.code is distinct from old.code
          or new.parent_id is distinct from old.parent_id or new.status is distinct from old.status
          or new.source is distinct from old.source or new.source_external_id is distinct from old.source_external_id) then
    raise exception 'HR_FIELD_READ_ONLY' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: organization_no_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.organization_no_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from organization where id = new.parent_id
        union all
        select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'organization tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: person_hr_read_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.person_hr_read_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.source = 'HR' and coalesce(current_setting('tmrkz.hr_projection', true), '') <> 'on'
     and (new.display_name is distinct from old.display_name or new.employee_no is distinct from old.employee_no
          or new.status is distinct from old.status or new.source is distinct from old.source
          or new.source_external_id is distinct from old.source_external_id) then
    raise exception 'HR_FIELD_READ_ONLY' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: resource_no_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resource_no_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.parent_resource_id is null then return new; end if;
  if new.parent_resource_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_resource_id from resource where id = new.parent_resource_id
        union all
        select r.id, r.parent_resource_id from resource r join up on r.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'resource tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: resource_shared_peak(uuid, tstzrange, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resource_shared_peak(rid uuid, win tstzrange, exclude uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  with o as (
    select tstzrange(period_start, period_end, '[)') as p from reservation
    where resource_id = rid and status = 'ACTIVE' and (exclude is null or id <> exclude)
      and tstzrange(period_start, period_end, '[)') && win),
  pts as (select lower(win) as t union select lower(p) from o where lower(p) > lower(win))
  select coalesce(max((select count(*) from o where o.p @> pts.t)), 0)::int from pts
$$;


--
-- Name: site_geometry_fill(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.site_geometry_fill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.geometry_type is null then new.geometry_type := new.geojson ->> 'type'; end if;
  if new.geom is null and new.crs = 'EPSG:4326' then new.geom := ST_SetSRID(ST_GeomFromGeoJSON(new.geojson::text), 4326); end if;
  return new;
end $$;


--
-- Name: site_no_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.site_no_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from site where id = new.parent_id
        union all
        select s.id, s.parent_id from site s join up on s.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'site tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: stationing_policy_version_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stationing_policy_version_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'stationing policy versions are append-only; publish a new version instead' using errcode = '42501';
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_policy_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_policy_version (
    id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    roles jsonb NOT NULL,
    note text,
    based_on uuid,
    restored_from uuid,
    fga_model_id text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    published_at timestamp with time zone,
    CONSTRAINT access_policy_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'SUPERSEDED'::text, 'DISCARDED'::text])))
);


--
-- Name: act_evt_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_evt_log (
    log_nr_ integer NOT NULL,
    type_ character varying(64),
    proc_def_id_ character varying(64),
    proc_inst_id_ character varying(64),
    execution_id_ character varying(64),
    task_id_ character varying(64),
    time_stamp_ timestamp without time zone NOT NULL,
    user_id_ character varying(255),
    data_ bytea,
    lock_owner_ character varying(255),
    lock_time_ timestamp without time zone,
    is_processed_ smallint DEFAULT 0
);


--
-- Name: act_evt_log_log_nr__seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.act_evt_log_log_nr__seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: act_evt_log_log_nr__seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.act_evt_log_log_nr__seq OWNED BY public.act_evt_log.log_nr_;


--
-- Name: act_ge_bytearray; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ge_bytearray (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    name_ character varying(255),
    deployment_id_ character varying(64),
    bytes_ bytea,
    generated_ boolean
);


--
-- Name: act_ge_property; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ge_property (
    name_ character varying(64) NOT NULL,
    value_ character varying(300),
    rev_ integer
);


--
-- Name: act_hi_actinst; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_actinst (
    id_ character varying(64) NOT NULL,
    rev_ integer DEFAULT 1,
    proc_def_id_ character varying(64) NOT NULL,
    proc_inst_id_ character varying(64) NOT NULL,
    execution_id_ character varying(64) NOT NULL,
    act_id_ character varying(255) NOT NULL,
    task_id_ character varying(64),
    call_proc_inst_id_ character varying(64),
    act_name_ character varying(255),
    act_type_ character varying(255) NOT NULL,
    assignee_ character varying(255),
    completed_by_ character varying(255),
    start_time_ timestamp without time zone NOT NULL,
    end_time_ timestamp without time zone,
    transaction_order_ integer,
    duration_ bigint,
    delete_reason_ character varying(4000),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_hi_attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_attachment (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    user_id_ character varying(255),
    name_ character varying(255),
    description_ character varying(4000),
    type_ character varying(255),
    task_id_ character varying(64),
    proc_inst_id_ character varying(64),
    url_ character varying(4000),
    content_id_ character varying(64),
    time_ timestamp without time zone
);


--
-- Name: act_hi_comment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_comment (
    id_ character varying(64) NOT NULL,
    type_ character varying(255),
    time_ timestamp without time zone NOT NULL,
    user_id_ character varying(255),
    task_id_ character varying(64),
    proc_inst_id_ character varying(64),
    action_ character varying(255),
    message_ character varying(4000),
    full_msg_ bytea
);


--
-- Name: act_hi_detail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_detail (
    id_ character varying(64) NOT NULL,
    type_ character varying(255) NOT NULL,
    proc_inst_id_ character varying(64),
    execution_id_ character varying(64),
    task_id_ character varying(64),
    act_inst_id_ character varying(64),
    name_ character varying(255) NOT NULL,
    var_type_ character varying(64),
    rev_ integer,
    time_ timestamp without time zone NOT NULL,
    bytearray_id_ character varying(64),
    double_ double precision,
    long_ bigint,
    text_ character varying(4000),
    text2_ character varying(4000)
);


--
-- Name: act_hi_entitylink; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_entitylink (
    id_ character varying(64) NOT NULL,
    link_type_ character varying(255),
    create_time_ timestamp without time zone,
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    parent_element_id_ character varying(255),
    ref_scope_id_ character varying(255),
    ref_scope_type_ character varying(255),
    ref_scope_definition_id_ character varying(255),
    root_scope_id_ character varying(255),
    root_scope_type_ character varying(255),
    hierarchy_type_ character varying(255)
);


--
-- Name: act_hi_identitylink; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_identitylink (
    id_ character varying(64) NOT NULL,
    group_id_ character varying(255),
    type_ character varying(255),
    user_id_ character varying(255),
    task_id_ character varying(64),
    create_time_ timestamp without time zone,
    proc_inst_id_ character varying(64),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255)
);


--
-- Name: act_hi_procinst; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_procinst (
    id_ character varying(64) NOT NULL,
    rev_ integer DEFAULT 1,
    proc_inst_id_ character varying(64) NOT NULL,
    business_key_ character varying(255),
    proc_def_id_ character varying(64) NOT NULL,
    start_time_ timestamp without time zone NOT NULL,
    end_time_ timestamp without time zone,
    duration_ bigint,
    start_user_id_ character varying(255),
    start_act_id_ character varying(255),
    end_act_id_ character varying(255),
    super_process_instance_id_ character varying(64),
    delete_reason_ character varying(4000),
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    name_ character varying(255),
    callback_id_ character varying(255),
    callback_type_ character varying(255),
    reference_id_ character varying(255),
    reference_type_ character varying(255),
    propagated_stage_inst_id_ character varying(255),
    business_status_ character varying(255),
    end_user_id_ character varying(255),
    state_ character varying(255)
);


--
-- Name: act_hi_taskinst; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_taskinst (
    id_ character varying(64) NOT NULL,
    rev_ integer DEFAULT 1,
    proc_def_id_ character varying(64),
    task_def_id_ character varying(64),
    task_def_key_ character varying(255),
    proc_inst_id_ character varying(64),
    execution_id_ character varying(64),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    propagated_stage_inst_id_ character varying(255),
    state_ character varying(255),
    name_ character varying(255),
    parent_task_id_ character varying(64),
    description_ character varying(4000),
    owner_ character varying(255),
    assignee_ character varying(255),
    start_time_ timestamp without time zone NOT NULL,
    in_progress_time_ timestamp without time zone,
    in_progress_started_by_ character varying(255),
    claim_time_ timestamp without time zone,
    claimed_by_ character varying(255),
    suspended_time_ timestamp without time zone,
    suspended_by_ character varying(255),
    end_time_ timestamp without time zone,
    completed_by_ character varying(255),
    duration_ bigint,
    delete_reason_ character varying(4000),
    priority_ integer,
    in_progress_due_date_ timestamp without time zone,
    due_date_ timestamp without time zone,
    form_key_ character varying(255),
    category_ character varying(255),
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    last_updated_time_ timestamp without time zone
);


--
-- Name: act_hi_tsk_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_tsk_log (
    id_ integer NOT NULL,
    type_ character varying(64),
    task_id_ character varying(64) NOT NULL,
    time_stamp_ timestamp without time zone NOT NULL,
    user_id_ character varying(255),
    data_ character varying(4000),
    execution_id_ character varying(64),
    proc_inst_id_ character varying(64),
    proc_def_id_ character varying(64),
    scope_id_ character varying(255),
    scope_definition_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_hi_tsk_log_id__seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.act_hi_tsk_log_id__seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: act_hi_tsk_log_id__seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.act_hi_tsk_log_id__seq OWNED BY public.act_hi_tsk_log.id_;


--
-- Name: act_hi_varinst; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_hi_varinst (
    id_ character varying(64) NOT NULL,
    rev_ integer DEFAULT 1,
    proc_inst_id_ character varying(64),
    execution_id_ character varying(64),
    task_id_ character varying(64),
    name_ character varying(255) NOT NULL,
    var_type_ character varying(100),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    bytearray_id_ character varying(64),
    double_ double precision,
    long_ bigint,
    text_ character varying(4000),
    text2_ character varying(4000),
    meta_info_ character varying(4000),
    create_time_ timestamp without time zone,
    last_updated_time_ timestamp without time zone
);


--
-- Name: act_id_bytearray; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_bytearray (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    name_ character varying(255),
    bytes_ bytea
);


--
-- Name: act_id_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_group (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    name_ character varying(255),
    type_ character varying(255)
);


--
-- Name: act_id_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_info (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    user_id_ character varying(64),
    type_ character varying(64),
    key_ character varying(255),
    value_ character varying(255),
    password_ bytea,
    parent_id_ character varying(255)
);


--
-- Name: act_id_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_membership (
    user_id_ character varying(64) NOT NULL,
    group_id_ character varying(64) NOT NULL
);


--
-- Name: act_id_priv; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_priv (
    id_ character varying(64) NOT NULL,
    name_ character varying(255) NOT NULL
);


--
-- Name: act_id_priv_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_priv_mapping (
    id_ character varying(64) NOT NULL,
    priv_id_ character varying(64) NOT NULL,
    user_id_ character varying(255),
    group_id_ character varying(255)
);


--
-- Name: act_id_property; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_property (
    name_ character varying(64) NOT NULL,
    value_ character varying(300),
    rev_ integer
);


--
-- Name: act_id_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_token (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    token_value_ character varying(255),
    token_date_ timestamp without time zone,
    ip_address_ character varying(255),
    user_agent_ character varying(255),
    user_id_ character varying(255),
    token_data_ character varying(2000)
);


--
-- Name: act_id_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_id_user (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    first_ character varying(255),
    last_ character varying(255),
    display_name_ character varying(255),
    email_ character varying(255),
    pwd_ character varying(255),
    picture_id_ character varying(64),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_procdef_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_procdef_info (
    id_ character varying(64) NOT NULL,
    proc_def_id_ character varying(64) NOT NULL,
    rev_ integer,
    info_json_id_ character varying(64)
);


--
-- Name: act_re_deployment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_re_deployment (
    id_ character varying(64) NOT NULL,
    name_ character varying(255),
    category_ character varying(255),
    key_ character varying(255),
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    deploy_time_ timestamp without time zone,
    derived_from_ character varying(64),
    derived_from_root_ character varying(64),
    parent_deployment_id_ character varying(255),
    engine_version_ character varying(255)
);


--
-- Name: act_re_model; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_re_model (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    name_ character varying(255),
    key_ character varying(255),
    category_ character varying(255),
    create_time_ timestamp without time zone,
    last_update_time_ timestamp without time zone,
    version_ integer,
    meta_info_ character varying(4000),
    deployment_id_ character varying(64),
    editor_source_value_id_ character varying(64),
    editor_source_extra_value_id_ character varying(64),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_re_procdef; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_re_procdef (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    name_ character varying(255),
    key_ character varying(255) NOT NULL,
    version_ integer NOT NULL,
    deployment_id_ character varying(64),
    resource_name_ character varying(4000),
    dgrm_resource_name_ character varying(4000),
    description_ character varying(4000),
    has_start_form_key_ boolean,
    has_graphical_notation_ boolean,
    suspension_state_ integer,
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    derived_from_ character varying(64),
    derived_from_root_ character varying(64),
    derived_version_ integer DEFAULT 0 NOT NULL,
    engine_version_ character varying(255)
);


--
-- Name: act_ru_actinst; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_actinst (
    id_ character varying(64) NOT NULL,
    rev_ integer DEFAULT 1,
    proc_def_id_ character varying(64) NOT NULL,
    proc_inst_id_ character varying(64) NOT NULL,
    execution_id_ character varying(64) NOT NULL,
    act_id_ character varying(255) NOT NULL,
    task_id_ character varying(64),
    call_proc_inst_id_ character varying(64),
    act_name_ character varying(255),
    act_type_ character varying(255) NOT NULL,
    assignee_ character varying(255),
    completed_by_ character varying(255),
    start_time_ timestamp without time zone NOT NULL,
    end_time_ timestamp without time zone,
    duration_ bigint,
    transaction_order_ integer,
    delete_reason_ character varying(4000),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_deadletter_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_deadletter_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    type_ character varying(255) NOT NULL,
    exclusive_ boolean,
    execution_id_ character varying(64),
    process_instance_id_ character varying(64),
    proc_def_id_ character varying(64),
    element_id_ character varying(255),
    element_name_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    correlation_id_ character varying(255),
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    duedate_ timestamp without time zone,
    repeat_ character varying(255),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    create_time_ timestamp without time zone,
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_entitylink; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_entitylink (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    create_time_ timestamp without time zone,
    link_type_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    parent_element_id_ character varying(255),
    ref_scope_id_ character varying(255),
    ref_scope_type_ character varying(255),
    ref_scope_definition_id_ character varying(255),
    root_scope_id_ character varying(255),
    root_scope_type_ character varying(255),
    hierarchy_type_ character varying(255)
);


--
-- Name: act_ru_event_subscr; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_event_subscr (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    event_type_ character varying(255) NOT NULL,
    event_name_ character varying(255),
    execution_id_ character varying(64),
    proc_inst_id_ character varying(64),
    activity_id_ character varying(64),
    configuration_ character varying(255),
    created_ timestamp without time zone NOT NULL,
    proc_def_id_ character varying(64),
    sub_scope_id_ character varying(64),
    scope_id_ character varying(64),
    scope_definition_id_ character varying(64),
    scope_definition_key_ character varying(255),
    scope_type_ character varying(64),
    lock_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_execution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_execution (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    proc_inst_id_ character varying(64),
    business_key_ character varying(255),
    parent_id_ character varying(64),
    proc_def_id_ character varying(64),
    super_exec_ character varying(64),
    root_proc_inst_id_ character varying(64),
    act_id_ character varying(255),
    is_active_ boolean,
    is_concurrent_ boolean,
    is_scope_ boolean,
    is_event_scope_ boolean,
    is_mi_root_ boolean,
    suspension_state_ integer,
    cached_ent_state_ integer,
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    name_ character varying(255),
    start_act_id_ character varying(255),
    start_time_ timestamp without time zone,
    start_user_id_ character varying(255),
    lock_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    is_count_enabled_ boolean,
    evt_subscr_count_ integer,
    task_count_ integer,
    job_count_ integer,
    timer_job_count_ integer,
    susp_job_count_ integer,
    deadletter_job_count_ integer,
    external_worker_job_count_ integer,
    var_count_ integer,
    id_link_count_ integer,
    callback_id_ character varying(255),
    callback_type_ character varying(255),
    reference_id_ character varying(255),
    reference_type_ character varying(255),
    propagated_stage_inst_id_ character varying(255),
    business_status_ character varying(255)
);


--
-- Name: act_ru_external_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_external_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    type_ character varying(255) NOT NULL,
    lock_exp_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    exclusive_ boolean,
    execution_id_ character varying(64),
    process_instance_id_ character varying(64),
    proc_def_id_ character varying(64),
    element_id_ character varying(255),
    element_name_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    correlation_id_ character varying(255),
    retries_ integer,
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    duedate_ timestamp without time zone,
    repeat_ character varying(255),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    create_time_ timestamp without time zone,
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_history_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_history_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    lock_exp_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    retries_ integer,
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    adv_handler_cfg_id_ character varying(64),
    create_time_ timestamp without time zone,
    scope_type_ character varying(255),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_identitylink; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_identitylink (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    group_id_ character varying(255),
    type_ character varying(255),
    user_id_ character varying(255),
    task_id_ character varying(64),
    proc_inst_id_ character varying(64),
    proc_def_id_ character varying(64),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255)
);


--
-- Name: act_ru_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    type_ character varying(255) NOT NULL,
    lock_exp_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    exclusive_ boolean,
    execution_id_ character varying(64),
    process_instance_id_ character varying(64),
    proc_def_id_ character varying(64),
    element_id_ character varying(255),
    element_name_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    correlation_id_ character varying(255),
    retries_ integer,
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    duedate_ timestamp without time zone,
    repeat_ character varying(255),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    create_time_ timestamp without time zone,
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_suspended_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_suspended_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    type_ character varying(255) NOT NULL,
    exclusive_ boolean,
    execution_id_ character varying(64),
    process_instance_id_ character varying(64),
    proc_def_id_ character varying(64),
    element_id_ character varying(255),
    element_name_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    correlation_id_ character varying(255),
    retries_ integer,
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    duedate_ timestamp without time zone,
    repeat_ character varying(255),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    create_time_ timestamp without time zone,
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_task (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    execution_id_ character varying(64),
    proc_inst_id_ character varying(64),
    proc_def_id_ character varying(64),
    task_def_id_ character varying(64),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    propagated_stage_inst_id_ character varying(255),
    state_ character varying(255),
    name_ character varying(255),
    parent_task_id_ character varying(64),
    description_ character varying(4000),
    task_def_key_ character varying(255),
    owner_ character varying(255),
    assignee_ character varying(255),
    delegation_ character varying(64),
    priority_ integer,
    create_time_ timestamp without time zone,
    in_progress_time_ timestamp without time zone,
    in_progress_started_by_ character varying(255),
    claim_time_ timestamp without time zone,
    claimed_by_ character varying(255),
    suspended_time_ timestamp without time zone,
    suspended_by_ character varying(255),
    in_progress_due_date_ timestamp without time zone,
    due_date_ timestamp without time zone,
    category_ character varying(255),
    suspension_state_ integer,
    tenant_id_ character varying(255) DEFAULT ''::character varying,
    form_key_ character varying(255),
    is_count_enabled_ boolean,
    var_count_ integer,
    id_link_count_ integer,
    sub_task_count_ integer
);


--
-- Name: act_ru_timer_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_timer_job (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    category_ character varying(255),
    type_ character varying(255) NOT NULL,
    lock_exp_time_ timestamp without time zone,
    lock_owner_ character varying(255),
    exclusive_ boolean,
    execution_id_ character varying(64),
    process_instance_id_ character varying(64),
    proc_def_id_ character varying(64),
    element_id_ character varying(255),
    element_name_ character varying(255),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    scope_definition_id_ character varying(255),
    correlation_id_ character varying(255),
    retries_ integer,
    exception_stack_id_ character varying(64),
    exception_msg_ character varying(4000),
    duedate_ timestamp without time zone,
    repeat_ character varying(255),
    handler_type_ character varying(255),
    handler_cfg_ character varying(4000),
    custom_values_id_ character varying(64),
    create_time_ timestamp without time zone,
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: act_ru_variable; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.act_ru_variable (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    type_ character varying(255) NOT NULL,
    name_ character varying(255) NOT NULL,
    execution_id_ character varying(64),
    proc_inst_id_ character varying(64),
    task_id_ character varying(64),
    scope_id_ character varying(255),
    sub_scope_id_ character varying(255),
    scope_type_ character varying(255),
    bytearray_id_ character varying(64),
    double_ double precision,
    long_ bigint,
    text_ character varying(4000),
    text2_ character varying(4000),
    meta_info_ character varying(4000)
);


--
-- Name: affiliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliation (
    id uuid NOT NULL,
    person_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    position_id text,
    position_title text,
    source text DEFAULT 'HR'::text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    ended_reason text,
    CONSTRAINT affiliation_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT affiliation_source_check CHECK ((source = 'HR'::text))
);


--
-- Name: approval_document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_document (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer NOT NULL,
    decision_id uuid NOT NULL,
    canonical jsonb NOT NULL,
    sha256 text NOT NULL,
    signature_mode text NOT NULL,
    signer_person_id uuid NOT NULL,
    signer_name text NOT NULL,
    signer_role text NOT NULL,
    signed_at timestamp with time zone NOT NULL,
    evidence text NOT NULL,
    signing_job_id uuid,
    CONSTRAINT approval_document_signature_mode_check CHECK ((signature_mode = ANY (ARRAY['INTERNAL_ATTESTATION'::text, 'PKI'::text])))
);


--
-- Name: attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachment (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    field_id text NOT NULL,
    version integer NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    storage_key text,
    scan_status text NOT NULL,
    scan_detail text,
    uploaded_by uuid NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by uuid,
    CONSTRAINT attachment_scan_status_check CHECK ((scan_status = ANY (ARRAY['PENDING'::text, 'CLEAN'::text, 'REJECTED'::text])))
);


--
-- Name: audit_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_event (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_person_id uuid,
    actor_name text,
    actor_role text,
    actor_org text,
    via_delegation_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    entity_label text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    reason text,
    revision integer,
    tx_id bigint DEFAULT txid_current() NOT NULL,
    trace_id text
);


--
-- Name: audit_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_event_id_seq OWNED BY public.audit_event.id;


--
-- Name: authz_change; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authz_change (
    seq bigint NOT NULL,
    person_id uuid,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: authz_change_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.authz_change_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: authz_change_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.authz_change_seq_seq OWNED BY public.authz_change.seq;


--
-- Name: authz_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authz_sync_state (
    id integer NOT NULL,
    store_id text,
    model_id text,
    model_hash text,
    applied_seq bigint DEFAULT 0 NOT NULL,
    tuples integer DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    last_duration_ms integer,
    last_error text,
    last_error_at timestamp with time zone,
    CONSTRAINT authz_sync_state_id_check CHECK ((id = 1))
);


--
-- Name: authz_tuple; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authz_tuple (
    object text NOT NULL,
    relation text NOT NULL,
    subject text NOT NULL,
    condition jsonb,
    person_id uuid,
    kind text NOT NULL,
    CONSTRAINT authz_tuple_kind_check CHECK ((kind = ANY (ARRAY['STRUCTURE'::text, 'GRANT'::text])))
);


--
-- Name: bootstrap_admin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bootstrap_admin (
    login text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    person_id uuid
);


--
-- Name: decision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decision (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer NOT NULL,
    task_id uuid,
    stage_key text NOT NULL,
    stage_name text NOT NULL,
    actor_person_id uuid NOT NULL,
    actor_name text NOT NULL,
    actor_role_code text NOT NULL,
    actor_role_name text NOT NULL,
    actor_org_id uuid,
    actor_org_name text,
    via_delegation_id uuid,
    decision text NOT NULL,
    reason_code text,
    note text,
    carried_from uuid,
    decided_at timestamp with time zone NOT NULL,
    by_requester boolean DEFAULT false NOT NULL,
    CONSTRAINT decision_decision_check CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REFER'::text, 'RETURN'::text, 'REJECT'::text, 'CARRIED_FORWARD'::text])))
);


--
-- Name: decision_communication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decision_communication (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    decision_id uuid,
    revision integer NOT NULL,
    outcome text NOT NULL,
    recipient_kind text NOT NULL,
    recipient_org_id uuid,
    recipient_person_id uuid,
    recipient_text text,
    channel text NOT NULL,
    reference text,
    document_revision integer,
    document_sha256 text,
    communicated_at timestamp with time zone NOT NULL,
    recorded_by uuid NOT NULL,
    recorded_by_name text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    note text,
    CONSTRAINT decision_communication_channel_check CHECK ((channel = ANY (ARRAY['IN_APP'::text, 'INTERNAL_MAIL'::text, 'OFFICIAL_LETTER'::text, 'HAND_DELIVERY'::text, 'OTHER'::text]))),
    CONSTRAINT decision_communication_check CHECK (((recipient_kind = 'ORGANIZATION'::text) = (recipient_org_id IS NOT NULL))),
    CONSTRAINT decision_communication_check1 CHECK (((recipient_kind = 'PERSON'::text) = (recipient_person_id IS NOT NULL))),
    CONSTRAINT decision_communication_check2 CHECK (((recipient_kind <> 'OTHER'::text) OR (length(COALESCE(recipient_text, ''::text)) >= 2))),
    CONSTRAINT decision_communication_note_check CHECK (((note IS NULL) OR (length(note) <= 2000))),
    CONSTRAINT decision_communication_outcome_check CHECK ((outcome = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text, 'RETURNED'::text, 'CLOSED'::text]))),
    CONSTRAINT decision_communication_recipient_kind_check CHECK ((recipient_kind = ANY (ARRAY['ORGANIZATION'::text, 'PERSON'::text, 'OTHER'::text]))),
    CONSTRAINT decision_communication_recipient_text_check CHECK (((recipient_text IS NULL) OR (length(recipient_text) <= 200))),
    CONSTRAINT decision_communication_reference_check CHECK (((reference IS NULL) OR (length(reference) <= 120)))
);


--
-- Name: delegation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegation (
    id uuid NOT NULL,
    delegator_id uuid NOT NULL,
    delegate_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone NOT NULL,
    reason text NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delegation_check CHECK ((valid_to > valid_from)),
    CONSTRAINT delegation_check1 CHECK ((delegator_id <> delegate_id))
);


--
-- Name: deployment_area; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_area (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    site_id uuid NOT NULL,
    role text NOT NULL,
    geom public.geometry(Polygon,4326) NOT NULL,
    state text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deployment_area_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT deployment_area_check1 CHECK (((state = 'RETIRED'::text) = (valid_to IS NOT NULL))),
    CONSTRAINT deployment_area_role_check CHECK ((role = ANY (ARRAY['PRIMARY'::text, 'ALTERNATIVE'::text]))),
    CONSTRAINT deployment_area_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: execution_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_task (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    role_code text NOT NULL,
    target_org_id uuid,
    due_at timestamp with time zone NOT NULL,
    evidence_required boolean NOT NULL,
    status text NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone,
    note text,
    evidence_attachment_id uuid,
    overdue_notified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_person_id uuid,
    awaiting_assignment boolean DEFAULT false NOT NULL,
    purpose text DEFAULT 'TASK'::text NOT NULL,
    CONSTRAINT execution_task_purpose_check CHECK ((purpose = ANY (ARRAY['HANDOVER'::text, 'RECEIPT'::text, 'ACKNOWLEDGEMENT'::text, 'TASK'::text]))),
    CONSTRAINT execution_task_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'DONE'::text])))
);


--
-- Name: export_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.export_job (
    id uuid NOT NULL,
    requested_by uuid NOT NULL,
    kind text NOT NULL,
    filter jsonb NOT NULL,
    status text NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    storage_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT export_job_status_check CHECK ((status = ANY (ARRAY['READY'::text, 'FAILED'::text])))
);


--
-- Name: flw_channel_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_channel_definition (
    id_ character varying(255) NOT NULL,
    name_ character varying(255),
    version_ integer,
    key_ character varying(255),
    category_ character varying(255),
    type_ character varying(255),
    implementation_ character varying(255),
    deployment_id_ character varying(255),
    create_time_ timestamp(3) without time zone,
    tenant_id_ character varying(255),
    resource_name_ character varying(255),
    description_ character varying(255)
);


--
-- Name: flw_event_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_event_definition (
    id_ character varying(255) NOT NULL,
    name_ character varying(255),
    version_ integer,
    key_ character varying(255),
    category_ character varying(255),
    deployment_id_ character varying(255),
    tenant_id_ character varying(255),
    resource_name_ character varying(255),
    description_ character varying(255)
);


--
-- Name: flw_event_deployment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_event_deployment (
    id_ character varying(255) NOT NULL,
    name_ character varying(255),
    category_ character varying(255),
    deploy_time_ timestamp(3) without time zone,
    tenant_id_ character varying(255),
    parent_deployment_id_ character varying(255)
);


--
-- Name: flw_event_resource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_event_resource (
    id_ character varying(255) NOT NULL,
    name_ character varying(255),
    deployment_id_ character varying(255),
    resource_bytes_ bytea
);


--
-- Name: flw_ru_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_ru_batch (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    type_ character varying(64) NOT NULL,
    search_key_ character varying(255),
    search_key2_ character varying(255),
    create_time_ timestamp without time zone NOT NULL,
    complete_time_ timestamp without time zone,
    status_ character varying(255),
    batch_doc_id_ character varying(64),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: flw_ru_batch_part; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flw_ru_batch_part (
    id_ character varying(64) NOT NULL,
    rev_ integer,
    batch_id_ character varying(64),
    type_ character varying(64) NOT NULL,
    scope_id_ character varying(64),
    sub_scope_id_ character varying(64),
    scope_type_ character varying(64),
    search_key_ character varying(255),
    search_key2_ character varying(255),
    create_time_ timestamp without time zone NOT NULL,
    complete_time_ timestamp without time zone,
    status_ character varying(255),
    result_doc_id_ character varying(64),
    tenant_id_ character varying(255) DEFAULT ''::character varying
);


--
-- Name: flyway_schema_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flyway_schema_history (
    installed_rank integer NOT NULL,
    version character varying(50),
    description character varying(200) NOT NULL,
    type character varying(20) NOT NULL,
    script character varying(1000) NOT NULL,
    checksum integer,
    installed_by character varying(100) NOT NULL,
    installed_on timestamp without time zone DEFAULT now() NOT NULL,
    execution_time integer NOT NULL,
    success boolean NOT NULL
);


--
-- Name: form_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_definition (
    id uuid NOT NULL,
    request_type_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: form_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_version (
    id uuid NOT NULL,
    form_id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    schema jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    published_at timestamp with time zone,
    CONSTRAINT form_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'RETIRED'::text])))
);


--
-- Name: hr_mapping_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_mapping_version (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    fields jsonb NOT NULL,
    active_rules jsonb NOT NULL,
    discovered_columns jsonb,
    discovered_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    published_at timestamp with time zone,
    CONSTRAINT hr_mapping_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'SUPERSEDED'::text])))
);


--
-- Name: hr_person; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_person (
    snapshot_id uuid NOT NULL,
    external_id text NOT NULL,
    employee_number text NOT NULL,
    legacy_employee_number text,
    domain_account text,
    full_name text NOT NULL,
    unit_external_id text,
    position_id text,
    position_title text,
    job_title text,
    status_text text,
    active boolean NOT NULL
);


--
-- Name: hr_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_snapshot (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    mapping_version_id uuid NOT NULL,
    status text NOT NULL,
    unit_count integer DEFAULT 0 NOT NULL,
    person_count integer DEFAULT 0 NOT NULL,
    active_unit_count integer DEFAULT 0 NOT NULL,
    active_person_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT hr_snapshot_status_check CHECK ((status = ANY (ARRAY['STAGING'::text, 'PUBLISHED'::text, 'SUPERSEDED'::text, 'DISCARDED'::text])))
);


--
-- Name: hr_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_source (
    id uuid NOT NULL,
    name text NOT NULL,
    provider text DEFAULT 'ORACLE'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    settings_ciphertext text,
    settings_key_id text,
    unit_view text,
    person_view text,
    connect_timeout_s integer DEFAULT 10 NOT NULL,
    call_timeout_ms integer DEFAULT 30000 NOT NULL,
    drop_percent integer DEFAULT 10 NOT NULL,
    drop_minimum integer DEFAULT 3 NOT NULL,
    max_age_hours integer DEFAULT 720 NOT NULL,
    last_connection_ok boolean,
    last_connection_at timestamp with time zone,
    last_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_source_call_timeout_ms_check CHECK (((call_timeout_ms >= 1000) AND (call_timeout_ms <= 300000))),
    CONSTRAINT hr_source_connect_timeout_s_check CHECK (((connect_timeout_s >= 1) AND (connect_timeout_s <= 300))),
    CONSTRAINT hr_source_drop_minimum_check CHECK ((drop_minimum >= 0)),
    CONSTRAINT hr_source_drop_percent_check CHECK (((drop_percent >= 0) AND (drop_percent <= 100))),
    CONSTRAINT hr_source_max_age_hours_check CHECK (((max_age_hours >= 1) AND (max_age_hours <= 8760))),
    CONSTRAINT hr_source_provider_check CHECK ((provider = 'ORACLE'::text))
);


--
-- Name: hr_sync_issue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_sync_issue (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    kind text NOT NULL,
    entity text NOT NULL,
    external_id text,
    detail text,
    CONSTRAINT hr_sync_issue_entity_check CHECK ((entity = ANY (ARRAY['UNIT'::text, 'PERSON'::text])))
);


--
-- Name: hr_sync_issue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_sync_issue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_sync_issue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_sync_issue_id_seq OWNED BY public.hr_sync_issue.id;


--
-- Name: hr_sync_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_sync_run (
    id uuid NOT NULL,
    source_id uuid,
    mapping_version_id uuid,
    trigger text NOT NULL,
    requested_by uuid,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    snapshot_id uuid,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    override_reason text,
    CONSTRAINT hr_sync_run_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'SUCCEEDED'::text, 'REJECTED'::text, 'FAILED'::text, 'SKIPPED'::text]))),
    CONSTRAINT hr_sync_run_trigger_check CHECK ((trigger = ANY (ARRAY['SCHEDULED'::text, 'MANUAL'::text])))
);


--
-- Name: hr_unit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_unit (
    snapshot_id uuid NOT NULL,
    external_id text NOT NULL,
    code text,
    name text NOT NULL,
    name_en text,
    parent_external_id text,
    status_raw text,
    active boolean NOT NULL,
    level integer
);


--
-- Name: idempotency_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_record (
    person_id uuid NOT NULL,
    idem_key text NOT NULL,
    operation text NOT NULL,
    request_hash text NOT NULL,
    status_code integer,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: identity_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_link (
    id uuid NOT NULL,
    person_id uuid NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    method text NOT NULL,
    linked_by uuid,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_link_method_check CHECK ((method = ANY (ARRAY['ENTERPRISE_KEY'::text, 'ADMINISTRATOR'::text, 'BOOTSTRAP'::text])))
);


--
-- Name: identity_link_issue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_link_issue (
    id uuid NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    claimed_key text,
    display_name text,
    reason text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolved_person_id uuid,
    resolution text,
    CONSTRAINT identity_link_issue_reason_check CHECK ((reason = ANY (ARRAY['NO_KEY'::text, 'NO_MATCH'::text, 'AMBIGUOUS'::text, 'INACTIVE'::text, 'STALE_SOURCE'::text, 'ALREADY_LINKED'::text]))),
    CONSTRAINT identity_link_issue_resolution_check CHECK ((resolution = ANY (ARRAY['LINKED'::text, 'DISMISSED'::text])))
);


--
-- Name: integration_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_run (
    id uuid NOT NULL,
    connector text NOT NULL,
    status text NOT NULL,
    payload jsonb NOT NULL,
    result jsonb NOT NULL,
    started_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT integration_run_status_check CHECK ((status = ANY (ARRAY['PREVIEWED'::text, 'INVALID'::text, 'COMMITTED'::text, 'FAILED'::text])))
);


--
-- Name: local_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_metadata (
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    display_name text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT local_metadata_entity_type_check CHECK ((entity_type = ANY (ARRAY['ORGANIZATION'::text, 'PERSON'::text])))
);


--
-- Name: login_throttle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_throttle (
    key text NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone
);


--
-- Name: map_import_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_import_job (
    id uuid NOT NULL,
    file_name text NOT NULL,
    format text NOT NULL,
    declared_crs text,
    effective_crs text,
    status text NOT NULL,
    report jsonb NOT NULL,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    original_sha256 text NOT NULL,
    original_content text,
    target_site_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    reason text,
    CONSTRAINT map_import_job_format_check CHECK ((format = ANY (ARRAY['GEOJSON'::text, 'KML'::text]))),
    CONSTRAINT map_import_job_status_check CHECK ((status = ANY (ARRAY['PREVIEWED'::text, 'REJECTED'::text, 'PUBLISHED'::text, 'CANCELLED'::text])))
);


--
-- Name: map_package; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_package (
    id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    data_date date NOT NULL,
    source text NOT NULL,
    license text NOT NULL,
    attribution_html text NOT NULL,
    crs text NOT NULL,
    min_lat double precision NOT NULL,
    min_lng double precision NOT NULL,
    max_lat double precision NOT NULL,
    max_lng double precision NOT NULL,
    format text NOT NULL,
    local_path text NOT NULL,
    content_sha256 text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'overlay'::text NOT NULL,
    kind text DEFAULT 'ROADS'::text NOT NULL,
    min_zoom numeric(4,1),
    max_zoom numeric(4,1),
    storage text DEFAULT 'BUILTIN'::text NOT NULL,
    manifest jsonb,
    uploaded_by uuid,
    status_changed_by uuid,
    status_changed_at timestamp with time zone,
    status_reason text,
    CONSTRAINT map_package_format_check CHECK ((format = ANY (ARRAY['SVG_OVERLAY'::text, 'RASTER_IMAGE'::text, 'GEOJSON'::text]))),
    CONSTRAINT map_package_kind_check CHECK ((kind = ANY (ARRAY['ROADS'::text, 'AERIAL'::text, 'FACILITY_PLAN'::text, 'SOURCE_DATA'::text]))),
    CONSTRAINT map_package_role_check CHECK ((role = ANY (ARRAY['overlay'::text, 'source'::text]))),
    CONSTRAINT map_package_status_check CHECK ((status = ANY (ARRAY['PENDING_REVIEW'::text, 'ACTIVE'::text, 'DISABLED'::text, 'REJECTED'::text, 'RETIRED'::text]))),
    CONSTRAINT map_package_storage_check CHECK ((storage = ANY (ARRAY['BUILTIN'::text, 'MANAGED'::text])))
);


--
-- Name: membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership (
    id uuid NOT NULL,
    person_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    role_code text NOT NULL,
    position_title text,
    site_scope_id uuid,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    ended_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    follows_affiliation boolean DEFAULT true NOT NULL,
    scope_mode text DEFAULT 'ROLE'::text NOT NULL,
    scope_combine text DEFAULT 'AND'::text NOT NULL,
    scope_all boolean DEFAULT false NOT NULL,
    granted_by uuid,
    CONSTRAINT membership_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT membership_check1 CHECK (((scope_mode = 'CUSTOM'::text) OR (NOT scope_all))),
    CONSTRAINT membership_scope_combine_check CHECK ((scope_combine = ANY (ARRAY['AND'::text, 'OR'::text]))),
    CONSTRAINT membership_scope_mode_check CHECK ((scope_mode = ANY (ARRAY['ROLE'::text, 'CUSTOM'::text])))
);


--
-- Name: membership_scope_target; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_scope_target (
    membership_id uuid NOT NULL,
    kind text NOT NULL,
    target_id uuid NOT NULL,
    include_descendants boolean DEFAULT true NOT NULL,
    CONSTRAINT membership_scope_target_check CHECK (((kind <> 'RESOURCE'::text) OR (NOT include_descendants))),
    CONSTRAINT membership_scope_target_kind_check CHECK ((kind = ANY (ARRAY['ORGANIZATION'::text, 'SITE'::text, 'RESOURCE'::text])))
);


--
-- Name: notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification (
    id uuid NOT NULL,
    person_id uuid NOT NULL,
    outbox_event_id bigint,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: oidc_login; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_login (
    state_hash text NOT NULL,
    browser_hash text NOT NULL,
    code_verifier text NOT NULL,
    nonce text NOT NULL,
    purpose text NOT NULL,
    return_to text NOT NULL,
    session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT oidc_login_purpose_check CHECK ((purpose = ANY (ARRAY['LOGIN'::text, 'REAUTH'::text])))
);


--
-- Name: org_stationing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_stationing (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    site_id uuid NOT NULL,
    kind text NOT NULL,
    base_id uuid,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    planned_end timestamp with time zone,
    origin text NOT NULL,
    request_id uuid,
    reason text NOT NULL,
    reference text,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    end_reason text,
    ended_by uuid,
    ended_at timestamp with time zone,
    start_held_at timestamp with time zone,
    CONSTRAINT org_stationing_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT org_stationing_check1 CHECK (((valid_to IS NULL) = (end_reason IS NULL))),
    CONSTRAINT org_stationing_check2 CHECK ((((kind = 'PERMANENT'::text) AND (base_id IS NULL) AND (planned_end IS NULL)) OR ((kind = 'TEMPORARY'::text) AND (base_id IS NOT NULL) AND (planned_end IS NOT NULL) AND (planned_end > valid_from)))),
    CONSTRAINT org_stationing_check3 CHECK (((origin = 'CORRECTION'::text) OR (request_id IS NOT NULL))),
    CONSTRAINT org_stationing_end_reason_check CHECK ((end_reason = ANY (ARRAY['SUPERSEDED'::text, 'CORRECTED'::text, 'RETURNED'::text, 'CANCELLED'::text, 'ENDED_EARLY'::text, 'WINDOW_EXPIRED'::text]))),
    CONSTRAINT org_stationing_held_check CHECK (((start_held_at IS NULL) OR (kind = 'TEMPORARY'::text))),
    CONSTRAINT org_stationing_kind_check CHECK ((kind = ANY (ARRAY['PERMANENT'::text, 'TEMPORARY'::text]))),
    CONSTRAINT org_stationing_origin_check CHECK ((origin = ANY (ARRAY['CORRECTION'::text, 'REQUEST'::text]))),
    CONSTRAINT org_stationing_reason_check CHECK ((length(btrim(reason)) >= 5))
);


--
-- Name: org_unit_symbol; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_unit_symbol (
    organization_id uuid NOT NULL,
    standard text NOT NULL,
    edition text NOT NULL,
    sidc text NOT NULL,
    description_ar text NOT NULL,
    source text NOT NULL,
    catalog_code text,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT org_unit_symbol_check CHECK (((source = 'CATALOG'::text) = (catalog_code IS NOT NULL))),
    CONSTRAINT org_unit_symbol_description_ar_check CHECK (((length(description_ar) >= 2) AND (length(description_ar) <= 200))),
    CONSTRAINT org_unit_symbol_edition_check CHECK ((edition = ANY (ARRAY['D'::text, 'E'::text]))),
    CONSTRAINT org_unit_symbol_sidc_check CHECK ((sidc ~ '^[0-9]{20}([0-9]{10})?$'::text)),
    CONSTRAINT org_unit_symbol_source_check CHECK ((source = ANY (ARRAY['CATALOG'::text, 'MANUAL'::text]))),
    CONSTRAINT org_unit_symbol_standard_check CHECK ((standard = ANY (ARRAY['APP6'::text, '2525'::text])))
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    parent_id uuid,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'LOCAL'::text NOT NULL,
    source_external_id text,
    CONSTRAINT organization_source_check CHECK ((source = ANY (ARRAY['LOCAL'::text, 'HR'::text]))),
    CONSTRAINT organization_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: outbox_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_event (
    id bigint NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    delivery_state text DEFAULT 'PENDING'::text NOT NULL,
    processed_at timestamp with time zone,
    last_error text,
    CONSTRAINT outbox_event_delivery_state_check CHECK ((delivery_state = ANY (ARRAY['PENDING'::text, 'DONE'::text, 'FAILED'::text])))
);


--
-- Name: outbox_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbox_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbox_event_id_seq OWNED BY public.outbox_event.id;


--
-- Name: person; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.person (
    id uuid NOT NULL,
    employee_no text NOT NULL,
    display_name text NOT NULL,
    username text,
    password_hash text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'LOCAL'::text NOT NULL,
    source_external_id text,
    bootstrap boolean DEFAULT false NOT NULL,
    CONSTRAINT person_source_check CHECK ((source = ANY (ARRAY['LOCAL'::text, 'HR'::text]))),
    CONSTRAINT person_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text])))
);


--
-- Name: placement_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.placement_rule (
    id uuid NOT NULL,
    name text NOT NULL,
    action text NOT NULL,
    station_level text,
    organization_id uuid,
    include_descendants boolean DEFAULT true NOT NULL,
    min_m double precision DEFAULT 0 NOT NULL,
    max_m double precision,
    measure text DEFAULT 'CENTER'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT placement_rule_action_check CHECK ((action = ANY (ARRAY['RELOCATE'::text, 'WORK_AREA'::text]))),
    CONSTRAINT placement_rule_check CHECK (((max_m IS NULL) OR (max_m > min_m))),
    CONSTRAINT placement_rule_measure_check CHECK ((measure = ANY (ARRAY['CENTER'::text, 'EDGE'::text]))),
    CONSTRAINT placement_rule_min_m_check CHECK ((min_m >= (0)::double precision)),
    CONSTRAINT placement_rule_name_check CHECK (((length(name) >= 2) AND (length(name) <= 120))),
    CONSTRAINT placement_rule_station_level_check CHECK ((station_level = ANY (ARRAY['MAIN'::text, 'BRANCH'::text])))
);


--
-- Name: policy_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_version (
    id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    settings jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    published_at timestamp with time zone,
    CONSTRAINT policy_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'RETIRED'::text])))
);


--
-- Name: position_seat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.position_seat (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    position_id text NOT NULL,
    name text NOT NULL,
    role_code text NOT NULL,
    site_scope_id uuid,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request (
    id uuid NOT NULL,
    number text NOT NULL,
    type_code text NOT NULL,
    status text NOT NULL,
    origin text NOT NULL,
    owner_org_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone,
    decided_at timestamp with time zone,
    closed_at timestamp with time zone,
    version integer DEFAULT 0 NOT NULL,
    current_revision integer DEFAULT 0 NOT NULL,
    draft jsonb NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    target_reservation_id uuid,
    form_version_id uuid NOT NULL,
    workflow_version_id uuid,
    policy_version_id uuid,
    process_instance_id text,
    last_note text,
    completion_statement text,
    completion_reference text,
    completed_by uuid,
    CONSTRAINT request_origin_check CHECK ((origin = ANY (ARRAY['MAP'::text, 'LIST'::text]))),
    CONSTRAINT request_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'RETURNED'::text, 'REJECTED'::text, 'APPROVED'::text, 'CLOSED'::text])))
);


--
-- Name: request_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.request_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: request_participant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_participant (
    request_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    relation text NOT NULL,
    CONSTRAINT request_participant_relation_check CHECK ((relation = ANY (ARRAY['PARTICIPANT'::text, 'INFO'::text])))
);


--
-- Name: request_relocation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_relocation (
    request_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    include_descendants boolean DEFAULT false NOT NULL,
    from_site_id uuid NOT NULL,
    proposed_name text NOT NULL,
    proposed_geojson jsonb NOT NULL,
    proposed_geom public.geometry(Geometry,4326) NOT NULL,
    area_m2 double precision,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    action text DEFAULT 'RELOCATE'::text NOT NULL,
    station_level text,
    temporary boolean DEFAULT false NOT NULL,
    temporary_end timestamp with time zone,
    target_site_id uuid,
    included_org_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    distance_m double precision,
    rule_id uuid,
    rule_version integer,
    check_status text,
    CONSTRAINT request_relocation_action_check CHECK ((action = ANY (ARRAY['RELOCATE'::text, 'WORK_AREA'::text]))),
    CONSTRAINT request_relocation_check_status_check CHECK ((check_status = ANY (ARRAY['OK'::text, 'OUT_OF_RANGE'::text, 'OCCUPIED'::text]))),
    CONSTRAINT request_relocation_proposed_name_check CHECK (((length(proposed_name) >= 2) AND (length(proposed_name) <= 120))),
    CONSTRAINT request_relocation_station_level_check CHECK ((station_level = ANY (ARRAY['MAIN'::text, 'BRANCH'::text])))
);


--
-- Name: request_resource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_resource (
    request_id uuid NOT NULL,
    resource_id uuid NOT NULL
);


--
-- Name: request_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_revision (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer NOT NULL,
    data jsonb NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    form_version_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    policy_version_id uuid NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamp with time zone NOT NULL,
    reason text,
    content_sha256 text NOT NULL,
    carried_stages text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: request_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_type (
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    multi_sites boolean DEFAULT true NOT NULL,
    multi_orgs boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    open_end_allowed boolean DEFAULT true NOT NULL,
    CONSTRAINT request_type_kind_check CHECK ((kind = ANY (ARRAY['NEW_RESERVATION'::text, 'EXTENSION'::text, 'MODIFICATION'::text, 'CANCELLATION'::text, 'EVACUATION'::text, 'RELOCATION'::text])))
);


--
-- Name: reservation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation (
    id uuid NOT NULL,
    resource_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    request_id uuid,
    request_revision integer,
    source text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone,
    status text NOT NULL,
    purpose text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    CONSTRAINT reservation_check CHECK (((period_end IS NULL) OR (period_end > period_start))),
    CONSTRAINT reservation_source_check CHECK ((source = ANY (ARRAY['APPROVAL'::text, 'SEED_IMPORT'::text]))),
    CONSTRAINT reservation_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'CANCELLED'::text, 'RELEASED'::text])))
);


--
-- Name: reservation_change; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_change (
    id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    request_id uuid,
    change_kind text NOT NULL,
    previous_start timestamp with time zone,
    previous_end timestamp with time zone,
    new_start timestamp with time zone,
    new_end timestamp with time zone,
    previous_status text,
    new_status text,
    effective_at timestamp with time zone NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reservation_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_lock (
    id bigint NOT NULL,
    reservation_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    kind text NOT NULL,
    period tstzrange NOT NULL,
    CONSTRAINT reservation_lock_kind_check CHECK ((kind = ANY (ARRAY['X'::text, 'I'::text])))
);


--
-- Name: reservation_lock_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reservation_lock_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reservation_lock_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reservation_lock_id_seq OWNED BY public.reservation_lock.id;


--
-- Name: resource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    policy text NOT NULL,
    parent_resource_id uuid,
    handover_minutes integer DEFAULT 0 NOT NULL,
    capacity integer,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    child_blocking boolean DEFAULT true NOT NULL,
    shared_limit integer,
    CONSTRAINT resource_handover_minutes_check CHECK ((handover_minutes >= 0)),
    CONSTRAINT resource_policy_check CHECK ((policy = ANY (ARRAY['EXCLUSIVE'::text, 'SHARED'::text]))),
    CONSTRAINT resource_shared_limit_check CHECK (((shared_limit IS NULL) OR (shared_limit >= 1))),
    CONSTRAINT resource_shared_limit_policy CHECK (((shared_limit IS NULL) OR (policy = 'SHARED'::text))),
    CONSTRAINT resource_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: restationing_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restationing_action (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    requested_by uuid NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    reason text NOT NULL,
    resume_state text,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason text,
    via_delegation uuid,
    held_at timestamp with time zone,
    closed_at timestamp with time zone,
    close_reason text,
    CONSTRAINT restationing_action_check CHECK (((state = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text])) = ((decided_by IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT restationing_action_check1 CHECK (((state = ANY (ARRAY['NO_LONGER_ACTIONABLE'::text, 'SUPERSEDED'::text])) = ((closed_at IS NOT NULL) AND (close_reason IS NOT NULL)))),
    CONSTRAINT restationing_action_decision_reason_check CHECK (((decision_reason IS NULL) OR (length(btrim(decision_reason)) >= 5))),
    CONSTRAINT restationing_action_kind_check CHECK ((kind = ANY (ARRAY['PRE_ACTIVATION_CANCELLATION'::text, 'BEFORE_START_CANCELLATION'::text, 'EARLY_RETURN'::text]))),
    CONSTRAINT restationing_action_reason_check CHECK ((length(btrim(reason)) >= 5)),
    CONSTRAINT restationing_action_state_check CHECK ((state = ANY (ARRAY['REQUESTED'::text, 'APPROVED'::text, 'REJECTED'::text, 'NO_LONGER_ACTIONABLE'::text, 'SUPERSEDED'::text])))
);


--
-- Name: restationing_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restationing_request (
    id uuid NOT NULL,
    number text NOT NULL,
    requester_id uuid NOT NULL,
    requesting_unit_id uuid NOT NULL,
    state text NOT NULL,
    kind text NOT NULL,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone,
    reason text DEFAULT ''::text NOT NULL,
    content jsonb NOT NULL,
    policy_version integer,
    route_no integer DEFAULT 0 NOT NULL,
    route_path uuid[],
    hierarchy_snapshot jsonb,
    returned jsonb,
    paused jsonb,
    final_approver_id uuid,
    activated_by uuid,
    activated_at timestamp with time zone,
    site_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    parent_request_id uuid,
    lapsed_at timestamp with time zone,
    lapse_reason text,
    CONSTRAINT restationing_request_activated_check CHECK (((state <> ALL (ARRAY['ACTIVATED_PERMANENT'::text, 'TEMPORARY_SCHEDULED'::text, 'START_HELD_PENDING_CANCELLATION'::text, 'ACTIVE_TEMPORARY'::text, 'TEMPORARY_RETURNED'::text, 'TEMPORARY_CANCELLED_BEFORE_START'::text, 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START'::text, 'EXTENSION_ACTIVATED'::text])) OR (activated_at IS NOT NULL))),
    CONSTRAINT restationing_request_check CHECK (((end_at IS NULL) OR (end_at > start_at))),
    CONSTRAINT restationing_request_check1 CHECK (((state = 'DRAFT'::text) OR ((policy_version IS NOT NULL) AND (route_path IS NOT NULL) AND (hierarchy_snapshot IS NOT NULL)))),
    CONSTRAINT restationing_request_check2 CHECK ((((activated_at IS NULL) = (activated_by IS NULL)) AND ((activated_at IS NULL) = (site_id IS NULL)))),
    CONSTRAINT restationing_request_kind_check CHECK ((kind = ANY (ARRAY['PERMANENT'::text, 'TEMPORARY'::text, 'EXTENSION'::text]))),
    CONSTRAINT restationing_request_lapse_check CHECK (((state = 'LAPSED_NOT_ACTIVATED'::text) = ((lapsed_at IS NOT NULL) AND (lapse_reason IS NOT NULL)))),
    CONSTRAINT restationing_request_parent_check CHECK (((kind = 'EXTENSION'::text) = (parent_request_id IS NOT NULL))),
    CONSTRAINT restationing_request_state_check CHECK ((state = ANY (ARRAY['DRAFT'::text, 'UNDER_REVIEW'::text, 'RETURNED_FOR_CHANGES'::text, 'PAUSED_HIERARCHY_CHANGED'::text, 'REJECTED'::text, 'APPROVED_NOT_ACTIVATED'::text, 'CANCELLATION_PENDING'::text, 'CANCELLED_BEFORE_ACTIVATION'::text, 'ACTIVATED_PERMANENT'::text, 'TEMPORARY_SCHEDULED'::text, 'START_HELD_PENDING_CANCELLATION'::text, 'ACTIVE_TEMPORARY'::text, 'TEMPORARY_RETURNED'::text, 'TEMPORARY_CANCELLED_BEFORE_START'::text, 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START'::text, 'EXTENSION_ACTIVATED'::text, 'LAPSED_NOT_ACTIVATED'::text])))
);


--
-- Name: restationing_request_no; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.restationing_request_no
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: restationing_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restationing_revision (
    request_id uuid NOT NULL,
    n integer NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamp with time zone NOT NULL,
    content jsonb NOT NULL,
    changed text[] NOT NULL,
    reason text,
    invalidated jsonb NOT NULL,
    carried text[] NOT NULL,
    route_no integer NOT NULL,
    policy_version integer NOT NULL,
    checks jsonb NOT NULL,
    CONSTRAINT restationing_revision_n_check CHECK ((n > 0))
);


--
-- Name: restationing_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restationing_stage (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    route_no integer NOT NULL,
    "position" integer NOT NULL,
    stage_key text NOT NULL,
    kind text NOT NULL,
    unit_id uuid,
    permission text NOT NULL,
    label text NOT NULL,
    satisfies jsonb NOT NULL,
    depends_on text[] NOT NULL,
    final_stage boolean NOT NULL,
    independent_of text,
    mark text,
    decided_by uuid,
    via_delegation uuid,
    decided_at timestamp with time zone,
    CONSTRAINT restationing_stage_check CHECK (((kind = 'EXCEPTION'::text) = (unit_id IS NULL))),
    CONSTRAINT restationing_stage_check1 CHECK ((((mark IS NULL) = (decided_by IS NULL)) AND ((decided_by IS NULL) = (decided_at IS NULL)))),
    CONSTRAINT restationing_stage_kind_check CHECK ((kind = ANY (ARRAY['HIERARCHY'::text, 'CROSS_BRANCH'::text, 'EXCEPTION'::text]))),
    CONSTRAINT restationing_stage_mark_check CHECK ((mark = ANY (ARRAY['APPROVED'::text, 'CARRIED'::text])))
);


--
-- Name: role_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_def (
    code text NOT NULL,
    name text NOT NULL,
    permissions text[] NOT NULL,
    scope text NOT NULL,
    summary_only boolean DEFAULT false NOT NULL,
    system boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grantable_roles text[] DEFAULT '{}'::text[] NOT NULL,
    policy_version integer,
    CONSTRAINT role_def_scope_check CHECK ((scope = ANY (ARRAY['ALL'::text, 'ORGANIZATION'::text, 'SITE'::text, 'ORGANIZATION_AND_SITE'::text])))
);


--
-- Name: signature_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signature_evidence (
    id uuid NOT NULL,
    signing_job_id uuid NOT NULL,
    kind text NOT NULL,
    signature_id text,
    certificate text NOT NULL,
    subject text,
    issuer text,
    serial text,
    not_before timestamp with time zone,
    not_after timestamp with time zone,
    signing_time timestamp with time zone,
    indication text NOT NULL,
    sub_indication text,
    CONSTRAINT signature_evidence_kind_check CHECK ((kind = ANY (ARRAY['PERSON'::text, 'SEAL'::text])))
);


--
-- Name: signing_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signing_job (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer NOT NULL,
    task_id uuid NOT NULL,
    signer_person_id uuid NOT NULL,
    organization_id uuid,
    document_sha256 text NOT NULL,
    canonical jsonb NOT NULL,
    provider text NOT NULL,
    status text NOT NULL,
    failure_code text,
    failure_message text,
    signed_document bytea,
    decision_id uuid,
    unpublished_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signed_at timestamp with time zone,
    published_at timestamp with time zone,
    closed_at timestamp with time zone,
    CONSTRAINT signing_job_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'SIGNED'::text, 'FAILED'::text, 'PUBLISHED'::text, 'UNPUBLISHED'::text])))
);


--
-- Name: site; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site (
    id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    parent_id uuid,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    capacity integer,
    lat double precision,
    lng double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    marker public.geometry(Point,4326) GENERATED ALWAYS AS (
CASE
    WHEN ((lat IS NOT NULL) AND (lng IS NOT NULL)) THEN public.st_setsrid(public.st_makepoint(lng, lat), 4326)
    ELSE NULL::public.geometry
END) STORED,
    geometry_version integer,
    CONSTRAINT site_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: site_geometry_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_geometry_version (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    version integer NOT NULL,
    geojson jsonb NOT NULL,
    crs text NOT NULL,
    source text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    geom public.geometry(Geometry,4326),
    geometry_type text NOT NULL,
    original_format text,
    original_crs text,
    original_content text,
    original_sha256 text,
    source_file_name text,
    transform text,
    reason text,
    created_by uuid,
    import_job_id uuid,
    CONSTRAINT site_geometry_matches_type CHECK (((geom IS NULL) OR (public.geometrytype(geom) = upper(geometry_type)))),
    CONSTRAINT site_geometry_type_check CHECK ((geometry_type = ANY (ARRAY['Point'::text, 'Polygon'::text, 'MultiPolygon'::text])))
);


--
-- Name: site_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_link (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    source text DEFAULT 'TMRKZ'::text NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_by uuid,
    ended_reason text,
    CONSTRAINT site_link_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT site_link_check1 CHECK (((valid_to IS NULL) = (ended_reason IS NULL))),
    CONSTRAINT site_link_reason_check CHECK ((length(btrim(reason)) >= 5)),
    CONSTRAINT site_link_source_check CHECK (((length(btrim(source)) >= 2) AND (length(btrim(source)) <= 40)))
);


--
-- Name: site_responsibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_responsibility (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    CONSTRAINT site_responsibility_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);


--
-- Name: stationing_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stationing_outbox (
    seq bigint NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    organization_id uuid NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT stationing_outbox_check CHECK (((state = 'DELIVERED'::text) = (delivered_at IS NOT NULL))),
    CONSTRAINT stationing_outbox_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'DELIVERED'::text, 'FAILED'::text])))
);


--
-- Name: stationing_outbox_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stationing_outbox_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stationing_outbox_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stationing_outbox_seq_seq OWNED BY public.stationing_outbox.seq;


--
-- Name: stationing_policy_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stationing_policy_version (
    id uuid NOT NULL,
    version integer NOT NULL,
    previous_id uuid,
    policy_values jsonb NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    reason text NOT NULL,
    reference text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stationing_policy_version_check CHECK (((version = 1) = (previous_id IS NULL))),
    CONSTRAINT stationing_policy_version_check1 CHECK ((effective_from >= (created_at - '00:00:05'::interval))),
    CONSTRAINT stationing_policy_version_reason_check CHECK ((length(btrim(reason)) >= 5)),
    CONSTRAINT stationing_policy_version_version_check CHECK ((version > 0))
);


--
-- Name: task_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_assignment (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer NOT NULL,
    flowable_task_id text,
    process_instance_id text NOT NULL,
    stage_key text NOT NULL,
    stage_name text NOT NULL,
    role_code text NOT NULL,
    target_org_id uuid,
    final boolean NOT NULL,
    requires_signature boolean NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    due_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    overdue_notified boolean DEFAULT false NOT NULL,
    assigned_person_id uuid,
    awaiting_assignment boolean DEFAULT false NOT NULL,
    CONSTRAINT task_assignment_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'APPROVED'::text, 'RETURNED'::text, 'REJECTED'::text, 'CLOSED_BY_POLICY'::text, 'CANCELLED'::text])))
);


--
-- Name: task_reassignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_reassignment (
    id uuid NOT NULL,
    task_kind text NOT NULL,
    task_id uuid NOT NULL,
    request_id uuid NOT NULL,
    reason text NOT NULL,
    departed uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    holders uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    outcome text NOT NULL,
    routed_to_org uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_person_id uuid,
    resolution_reason text,
    CONSTRAINT task_reassignment_outcome_check CHECK ((outcome = ANY (ARRAY['SOLE_SUBSTITUTE'::text, 'ROUTED_TO_ACCESS_MANAGER'::text, 'POOL_CONTINUES'::text]))),
    CONSTRAINT task_reassignment_task_kind_check CHECK ((task_kind = ANY (ARRAY['REVIEW'::text, 'EXECUTION'::text])))
);


--
-- Name: terrain_dataset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terrain_dataset (
    id uuid NOT NULL,
    code text NOT NULL,
    version text NOT NULL,
    surface_model text NOT NULL,
    slope_encoding text NOT NULL,
    manifest jsonb NOT NULL,
    slope_sha256 text NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT terrain_dataset_surface_model_check CHECK ((surface_model = ANY (ARRAY['DSM'::text, 'DTM'::text])))
);


--
-- Name: terrain_slope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terrain_slope (
    rid bigint NOT NULL,
    dataset_id uuid NOT NULL,
    rast public.raster NOT NULL
);


--
-- Name: terrain_slope_rid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.terrain_slope_rid_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: terrain_slope_rid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.terrain_slope_rid_seq OWNED BY public.terrain_slope.rid;


--
-- Name: unit_symbol_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unit_symbol_catalog (
    code text NOT NULL,
    standard text NOT NULL,
    edition text NOT NULL,
    sidc text NOT NULL,
    name_ar text NOT NULL,
    description_ar text,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT unit_symbol_catalog_code_check CHECK ((code ~ '^[A-Z0-9_-]{2,40}$'::text)),
    CONSTRAINT unit_symbol_catalog_description_ar_check CHECK (((description_ar IS NULL) OR (length(description_ar) <= 300))),
    CONSTRAINT unit_symbol_catalog_edition_check CHECK ((edition = ANY (ARRAY['D'::text, 'E'::text]))),
    CONSTRAINT unit_symbol_catalog_name_ar_check CHECK (((length(name_ar) >= 2) AND (length(name_ar) <= 120))),
    CONSTRAINT unit_symbol_catalog_sidc_check CHECK ((sidc ~ '^[0-9]{20}([0-9]{10})?$'::text)),
    CONSTRAINT unit_symbol_catalog_standard_check CHECK ((standard = ANY (ARRAY['APP6'::text, '2525'::text])))
);


--
-- Name: user_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_session (
    id text NOT NULL,
    person_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    client_ip text,
    user_agent text,
    authenticated_at timestamp with time zone,
    issuer text,
    id_token text
);


--
-- Name: validation_report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.validation_report (
    id uuid NOT NULL,
    signing_job_id uuid NOT NULL,
    validated_at timestamp with time zone NOT NULL,
    validated_by uuid,
    passed boolean NOT NULL,
    summary jsonb NOT NULL
);


--
-- Name: workflow_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_definition (
    id uuid NOT NULL,
    request_type_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_version (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    definition jsonb NOT NULL,
    bpmn_xml text,
    deployment_id text,
    process_definition_id text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    published_at timestamp with time zone,
    CONSTRAINT workflow_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'RETIRED'::text])))
);


--
-- Name: act_evt_log log_nr_; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_evt_log ALTER COLUMN log_nr_ SET DEFAULT nextval('public.act_evt_log_log_nr__seq'::regclass);


--
-- Name: act_hi_tsk_log id_; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_tsk_log ALTER COLUMN id_ SET DEFAULT nextval('public.act_hi_tsk_log_id__seq'::regclass);


--
-- Name: audit_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_event ALTER COLUMN id SET DEFAULT nextval('public.audit_event_id_seq'::regclass);


--
-- Name: authz_change seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authz_change ALTER COLUMN seq SET DEFAULT nextval('public.authz_change_seq_seq'::regclass);


--
-- Name: hr_sync_issue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_issue ALTER COLUMN id SET DEFAULT nextval('public.hr_sync_issue_id_seq'::regclass);


--
-- Name: outbox_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_event ALTER COLUMN id SET DEFAULT nextval('public.outbox_event_id_seq'::regclass);


--
-- Name: reservation_lock id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock ALTER COLUMN id SET DEFAULT nextval('public.reservation_lock_id_seq'::regclass);


--
-- Name: stationing_outbox seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_outbox ALTER COLUMN seq SET DEFAULT nextval('public.stationing_outbox_seq_seq'::regclass);


--
-- Name: terrain_slope rid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terrain_slope ALTER COLUMN rid SET DEFAULT nextval('public.terrain_slope_rid_seq'::regclass);


--
-- Name: flw_channel_definition FLW_CHANNEL_DEFINITION_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_channel_definition
    ADD CONSTRAINT "FLW_CHANNEL_DEFINITION_pkey" PRIMARY KEY (id_);


--
-- Name: flw_event_definition FLW_EVENT_DEFINITION_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_event_definition
    ADD CONSTRAINT "FLW_EVENT_DEFINITION_pkey" PRIMARY KEY (id_);


--
-- Name: flw_event_deployment FLW_EVENT_DEPLOYMENT_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_event_deployment
    ADD CONSTRAINT "FLW_EVENT_DEPLOYMENT_pkey" PRIMARY KEY (id_);


--
-- Name: flw_event_resource FLW_EVENT_RESOURCE_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_event_resource
    ADD CONSTRAINT "FLW_EVENT_RESOURCE_pkey" PRIMARY KEY (id_);


--
-- Name: access_policy_version access_policy_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_pkey PRIMARY KEY (id);


--
-- Name: access_policy_version access_policy_version_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_version_key UNIQUE (version);


--
-- Name: act_evt_log act_evt_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_evt_log
    ADD CONSTRAINT act_evt_log_pkey PRIMARY KEY (log_nr_);


--
-- Name: act_ge_bytearray act_ge_bytearray_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ge_bytearray
    ADD CONSTRAINT act_ge_bytearray_pkey PRIMARY KEY (id_);


--
-- Name: act_ge_property act_ge_property_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ge_property
    ADD CONSTRAINT act_ge_property_pkey PRIMARY KEY (name_);


--
-- Name: act_hi_actinst act_hi_actinst_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_actinst
    ADD CONSTRAINT act_hi_actinst_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_attachment act_hi_attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_attachment
    ADD CONSTRAINT act_hi_attachment_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_comment act_hi_comment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_comment
    ADD CONSTRAINT act_hi_comment_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_detail act_hi_detail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_detail
    ADD CONSTRAINT act_hi_detail_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_entitylink act_hi_entitylink_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_entitylink
    ADD CONSTRAINT act_hi_entitylink_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_identitylink act_hi_identitylink_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_identitylink
    ADD CONSTRAINT act_hi_identitylink_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_procinst act_hi_procinst_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_procinst
    ADD CONSTRAINT act_hi_procinst_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_procinst act_hi_procinst_proc_inst_id__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_procinst
    ADD CONSTRAINT act_hi_procinst_proc_inst_id__key UNIQUE (proc_inst_id_);


--
-- Name: act_hi_taskinst act_hi_taskinst_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_taskinst
    ADD CONSTRAINT act_hi_taskinst_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_tsk_log act_hi_tsk_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_tsk_log
    ADD CONSTRAINT act_hi_tsk_log_pkey PRIMARY KEY (id_);


--
-- Name: act_hi_varinst act_hi_varinst_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_hi_varinst
    ADD CONSTRAINT act_hi_varinst_pkey PRIMARY KEY (id_);


--
-- Name: act_id_bytearray act_id_bytearray_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_bytearray
    ADD CONSTRAINT act_id_bytearray_pkey PRIMARY KEY (id_);


--
-- Name: act_id_group act_id_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_group
    ADD CONSTRAINT act_id_group_pkey PRIMARY KEY (id_);


--
-- Name: act_id_info act_id_info_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_info
    ADD CONSTRAINT act_id_info_pkey PRIMARY KEY (id_);


--
-- Name: act_id_membership act_id_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_membership
    ADD CONSTRAINT act_id_membership_pkey PRIMARY KEY (user_id_, group_id_);


--
-- Name: act_id_priv_mapping act_id_priv_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_priv_mapping
    ADD CONSTRAINT act_id_priv_mapping_pkey PRIMARY KEY (id_);


--
-- Name: act_id_priv act_id_priv_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_priv
    ADD CONSTRAINT act_id_priv_pkey PRIMARY KEY (id_);


--
-- Name: act_id_property act_id_property_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_property
    ADD CONSTRAINT act_id_property_pkey PRIMARY KEY (name_);


--
-- Name: act_id_token act_id_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_token
    ADD CONSTRAINT act_id_token_pkey PRIMARY KEY (id_);


--
-- Name: act_id_user act_id_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_user
    ADD CONSTRAINT act_id_user_pkey PRIMARY KEY (id_);


--
-- Name: act_procdef_info act_procdef_info_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_procdef_info
    ADD CONSTRAINT act_procdef_info_pkey PRIMARY KEY (id_);


--
-- Name: act_re_deployment act_re_deployment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_deployment
    ADD CONSTRAINT act_re_deployment_pkey PRIMARY KEY (id_);


--
-- Name: act_re_model act_re_model_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_model
    ADD CONSTRAINT act_re_model_pkey PRIMARY KEY (id_);


--
-- Name: act_re_procdef act_re_procdef_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_procdef
    ADD CONSTRAINT act_re_procdef_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_actinst act_ru_actinst_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_actinst
    ADD CONSTRAINT act_ru_actinst_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_deadletter_job act_ru_deadletter_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_ru_deadletter_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_entitylink act_ru_entitylink_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_entitylink
    ADD CONSTRAINT act_ru_entitylink_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_event_subscr act_ru_event_subscr_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_event_subscr
    ADD CONSTRAINT act_ru_event_subscr_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_execution act_ru_execution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_execution
    ADD CONSTRAINT act_ru_execution_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_external_job act_ru_external_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_external_job
    ADD CONSTRAINT act_ru_external_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_history_job act_ru_history_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_history_job
    ADD CONSTRAINT act_ru_history_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_identitylink act_ru_identitylink_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_identitylink
    ADD CONSTRAINT act_ru_identitylink_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_job act_ru_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_ru_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_suspended_job act_ru_suspended_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_ru_suspended_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_task act_ru_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_task
    ADD CONSTRAINT act_ru_task_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_timer_job act_ru_timer_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_ru_timer_job_pkey PRIMARY KEY (id_);


--
-- Name: act_ru_variable act_ru_variable_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_variable
    ADD CONSTRAINT act_ru_variable_pkey PRIMARY KEY (id_);


--
-- Name: act_procdef_info act_uniq_info_procdef; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_procdef_info
    ADD CONSTRAINT act_uniq_info_procdef UNIQUE (proc_def_id_);


--
-- Name: act_id_priv act_uniq_priv_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_priv
    ADD CONSTRAINT act_uniq_priv_name UNIQUE (name_);


--
-- Name: act_re_procdef act_uniq_procdef; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_procdef
    ADD CONSTRAINT act_uniq_procdef UNIQUE (key_, version_, derived_version_, tenant_id_);


--
-- Name: affiliation affiliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliation
    ADD CONSTRAINT affiliation_pkey PRIMARY KEY (id);


--
-- Name: approval_document approval_document_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_document
    ADD CONSTRAINT approval_document_pkey PRIMARY KEY (id);


--
-- Name: attachment attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (id);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (id);


--
-- Name: authz_change authz_change_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authz_change
    ADD CONSTRAINT authz_change_pkey PRIMARY KEY (seq);


--
-- Name: authz_sync_state authz_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authz_sync_state
    ADD CONSTRAINT authz_sync_state_pkey PRIMARY KEY (id);


--
-- Name: authz_tuple authz_tuple_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authz_tuple
    ADD CONSTRAINT authz_tuple_pkey PRIMARY KEY (object, relation, subject);


--
-- Name: bootstrap_admin bootstrap_admin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bootstrap_admin
    ADD CONSTRAINT bootstrap_admin_pkey PRIMARY KEY (login);


--
-- Name: decision_communication decision_communication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_pkey PRIMARY KEY (id);


--
-- Name: decision decision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_pkey PRIMARY KEY (id);


--
-- Name: delegation delegation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation
    ADD CONSTRAINT delegation_pkey PRIMARY KEY (id);


--
-- Name: deployment_area deployment_area_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_area
    ADD CONSTRAINT deployment_area_pkey PRIMARY KEY (id);


--
-- Name: deployment_area deployment_area_request_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_area
    ADD CONSTRAINT deployment_area_request_id_role_key UNIQUE (request_id, role);


--
-- Name: execution_task execution_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_pkey PRIMARY KEY (id);


--
-- Name: export_job export_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_job
    ADD CONSTRAINT export_job_pkey PRIMARY KEY (id);


--
-- Name: flw_ru_batch_part flw_ru_batch_part_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_ru_batch_part
    ADD CONSTRAINT flw_ru_batch_part_pkey PRIMARY KEY (id_);


--
-- Name: flw_ru_batch flw_ru_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_ru_batch
    ADD CONSTRAINT flw_ru_batch_pkey PRIMARY KEY (id_);


--
-- Name: flyway_schema_history flyway_schema_history_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flyway_schema_history
    ADD CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank);


--
-- Name: form_definition form_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_definition
    ADD CONSTRAINT form_definition_pkey PRIMARY KEY (id);


--
-- Name: form_definition form_definition_request_type_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_definition
    ADD CONSTRAINT form_definition_request_type_code_key UNIQUE (request_type_code);


--
-- Name: form_version form_version_form_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_form_id_version_key UNIQUE (form_id, version);


--
-- Name: form_version form_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_pkey PRIMARY KEY (id);


--
-- Name: hr_mapping_version hr_mapping_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_mapping_version
    ADD CONSTRAINT hr_mapping_version_pkey PRIMARY KEY (id);


--
-- Name: hr_mapping_version hr_mapping_version_source_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_mapping_version
    ADD CONSTRAINT hr_mapping_version_source_id_version_key UNIQUE (source_id, version);


--
-- Name: hr_person hr_person_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_person
    ADD CONSTRAINT hr_person_pkey PRIMARY KEY (snapshot_id, external_id);


--
-- Name: hr_snapshot hr_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_snapshot
    ADD CONSTRAINT hr_snapshot_pkey PRIMARY KEY (id);


--
-- Name: hr_source hr_source_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_source
    ADD CONSTRAINT hr_source_name_key UNIQUE (name);


--
-- Name: hr_source hr_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_source
    ADD CONSTRAINT hr_source_pkey PRIMARY KEY (id);


--
-- Name: hr_sync_issue hr_sync_issue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_issue
    ADD CONSTRAINT hr_sync_issue_pkey PRIMARY KEY (id);


--
-- Name: hr_sync_run hr_sync_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_run
    ADD CONSTRAINT hr_sync_run_pkey PRIMARY KEY (id);


--
-- Name: hr_unit hr_unit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_unit
    ADD CONSTRAINT hr_unit_pkey PRIMARY KEY (snapshot_id, external_id);


--
-- Name: idempotency_record idempotency_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_record
    ADD CONSTRAINT idempotency_record_pkey PRIMARY KEY (person_id, idem_key);


--
-- Name: identity_link_issue identity_link_issue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link_issue
    ADD CONSTRAINT identity_link_issue_pkey PRIMARY KEY (id);


--
-- Name: identity_link identity_link_issuer_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link
    ADD CONSTRAINT identity_link_issuer_subject_key UNIQUE (issuer, subject);


--
-- Name: identity_link identity_link_person_id_issuer_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link
    ADD CONSTRAINT identity_link_person_id_issuer_key UNIQUE (person_id, issuer);


--
-- Name: identity_link identity_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link
    ADD CONSTRAINT identity_link_pkey PRIMARY KEY (id);


--
-- Name: integration_run integration_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_run
    ADD CONSTRAINT integration_run_pkey PRIMARY KEY (id);


--
-- Name: local_metadata local_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_metadata
    ADD CONSTRAINT local_metadata_pkey PRIMARY KEY (entity_type, entity_id);


--
-- Name: login_throttle login_throttle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_throttle
    ADD CONSTRAINT login_throttle_pkey PRIMARY KEY (key);


--
-- Name: map_import_job map_import_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_import_job
    ADD CONSTRAINT map_import_job_pkey PRIMARY KEY (id);


--
-- Name: map_package map_package_code_version_format_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_package
    ADD CONSTRAINT map_package_code_version_format_key UNIQUE (code, version, format);


--
-- Name: map_package map_package_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_package
    ADD CONSTRAINT map_package_pkey PRIMARY KEY (id);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (id);


--
-- Name: membership_scope_target membership_scope_target_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_scope_target
    ADD CONSTRAINT membership_scope_target_pkey PRIMARY KEY (membership_id, kind, target_id);


--
-- Name: notification notification_outbox_event_id_person_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_outbox_event_id_person_id_kind_key UNIQUE (outbox_event_id, person_id, kind);


--
-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);


--
-- Name: oidc_login oidc_login_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_login
    ADD CONSTRAINT oidc_login_pkey PRIMARY KEY (state_hash);


--
-- Name: org_stationing org_stationing_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_no_overlap EXCLUDE USING gist (organization_id WITH =, kind WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: org_stationing org_stationing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_pkey PRIMARY KEY (id);


--
-- Name: org_unit_symbol org_unit_symbol_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_unit_symbol
    ADD CONSTRAINT org_unit_symbol_pkey PRIMARY KEY (organization_id);


--
-- Name: organization organization_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_code_key UNIQUE (code);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: outbox_event outbox_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_event
    ADD CONSTRAINT outbox_event_pkey PRIMARY KEY (id);


--
-- Name: person person_employee_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person
    ADD CONSTRAINT person_employee_no_key UNIQUE (employee_no);


--
-- Name: person person_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person
    ADD CONSTRAINT person_pkey PRIMARY KEY (id);


--
-- Name: person person_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person
    ADD CONSTRAINT person_username_key UNIQUE (username);


--
-- Name: placement_rule placement_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_rule
    ADD CONSTRAINT placement_rule_pkey PRIMARY KEY (id);


--
-- Name: policy_version policy_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_version
    ADD CONSTRAINT policy_version_pkey PRIMARY KEY (id);


--
-- Name: policy_version policy_version_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_version
    ADD CONSTRAINT policy_version_version_key UNIQUE (version);


--
-- Name: position_seat position_seat_organization_id_position_id_role_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_organization_id_position_id_role_code_key UNIQUE (organization_id, position_id, role_code);


--
-- Name: position_seat position_seat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_pkey PRIMARY KEY (id);


--
-- Name: request request_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_number_key UNIQUE (number);


--
-- Name: request_participant request_participant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_participant
    ADD CONSTRAINT request_participant_pkey PRIMARY KEY (request_id, organization_id, relation);


--
-- Name: request request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_pkey PRIMARY KEY (id);


--
-- Name: request_relocation request_relocation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_pkey PRIMARY KEY (request_id);


--
-- Name: request_resource request_resource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_resource
    ADD CONSTRAINT request_resource_pkey PRIMARY KEY (request_id, resource_id);


--
-- Name: request_revision request_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_pkey PRIMARY KEY (id);


--
-- Name: request_revision request_revision_request_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_request_id_revision_key UNIQUE (request_id, revision);


--
-- Name: request_type request_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_type
    ADD CONSTRAINT request_type_pkey PRIMARY KEY (code);


--
-- Name: reservation_change reservation_change_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_change
    ADD CONSTRAINT reservation_change_pkey PRIMARY KEY (id);


--
-- Name: reservation_lock reservation_lock_exclusive; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock
    ADD CONSTRAINT reservation_lock_exclusive EXCLUDE USING gist (resource_id WITH =, period WITH &&) WHERE ((kind = 'X'::text));


--
-- Name: reservation_lock reservation_lock_intent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock
    ADD CONSTRAINT reservation_lock_intent EXCLUDE USING gist (resource_id WITH =, period WITH &&, kind WITH <>);


--
-- Name: reservation_lock reservation_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock
    ADD CONSTRAINT reservation_lock_pkey PRIMARY KEY (id);


--
-- Name: reservation reservation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation
    ADD CONSTRAINT reservation_pkey PRIMARY KEY (id);


--
-- Name: resource resource_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource
    ADD CONSTRAINT resource_code_key UNIQUE (code);


--
-- Name: resource resource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource
    ADD CONSTRAINT resource_pkey PRIMARY KEY (id);


--
-- Name: restationing_action restationing_action_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_action
    ADD CONSTRAINT restationing_action_pkey PRIMARY KEY (id);


--
-- Name: restationing_request restationing_request_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_number_key UNIQUE (number);


--
-- Name: restationing_request restationing_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_pkey PRIMARY KEY (id);


--
-- Name: restationing_revision restationing_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_revision
    ADD CONSTRAINT restationing_revision_pkey PRIMARY KEY (request_id, n);


--
-- Name: restationing_stage restationing_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_pkey PRIMARY KEY (id);


--
-- Name: restationing_stage restationing_stage_request_id_route_no_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_request_id_route_no_position_key UNIQUE (request_id, route_no, "position");


--
-- Name: restationing_stage restationing_stage_request_id_route_no_stage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_request_id_route_no_stage_key_key UNIQUE (request_id, route_no, stage_key);


--
-- Name: role_def role_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_def
    ADD CONSTRAINT role_def_pkey PRIMARY KEY (code);


--
-- Name: signature_evidence signature_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_evidence
    ADD CONSTRAINT signature_evidence_pkey PRIMARY KEY (id);


--
-- Name: signing_job signing_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_pkey PRIMARY KEY (id);


--
-- Name: site site_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_code_key UNIQUE (code);


--
-- Name: site_geometry_version site_geometry_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_geometry_version
    ADD CONSTRAINT site_geometry_version_pkey PRIMARY KEY (id);


--
-- Name: site_geometry_version site_geometry_version_site_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_geometry_version
    ADD CONSTRAINT site_geometry_version_site_id_version_key UNIQUE (site_id, version);


--
-- Name: site_link site_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_link
    ADD CONSTRAINT site_link_pkey PRIMARY KEY (id);


--
-- Name: site site_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_pkey PRIMARY KEY (id);


--
-- Name: site_responsibility site_responsibility_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_responsibility
    ADD CONSTRAINT site_responsibility_no_overlap EXCLUDE USING gist (site_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: site_responsibility site_responsibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_responsibility
    ADD CONSTRAINT site_responsibility_pkey PRIMARY KEY (id);


--
-- Name: stationing_outbox stationing_outbox_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_outbox
    ADD CONSTRAINT stationing_outbox_event_id_key UNIQUE (event_id);


--
-- Name: stationing_outbox stationing_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_outbox
    ADD CONSTRAINT stationing_outbox_pkey PRIMARY KEY (seq);


--
-- Name: stationing_policy_version stationing_policy_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_policy_version
    ADD CONSTRAINT stationing_policy_version_pkey PRIMARY KEY (id);


--
-- Name: stationing_policy_version stationing_policy_version_previous_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_policy_version
    ADD CONSTRAINT stationing_policy_version_previous_id_key UNIQUE (previous_id);


--
-- Name: stationing_policy_version stationing_policy_version_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_policy_version
    ADD CONSTRAINT stationing_policy_version_version_key UNIQUE (version);


--
-- Name: task_assignment task_assignment_flowable_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_flowable_task_id_key UNIQUE (flowable_task_id);


--
-- Name: task_assignment task_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_pkey PRIMARY KEY (id);


--
-- Name: task_reassignment task_reassignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_reassignment
    ADD CONSTRAINT task_reassignment_pkey PRIMARY KEY (id);


--
-- Name: terrain_dataset terrain_dataset_code_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terrain_dataset
    ADD CONSTRAINT terrain_dataset_code_version_key UNIQUE (code, version);


--
-- Name: terrain_dataset terrain_dataset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terrain_dataset
    ADD CONSTRAINT terrain_dataset_pkey PRIMARY KEY (id);


--
-- Name: terrain_slope terrain_slope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terrain_slope
    ADD CONSTRAINT terrain_slope_pkey PRIMARY KEY (rid);


--
-- Name: unit_symbol_catalog unit_symbol_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_symbol_catalog
    ADD CONSTRAINT unit_symbol_catalog_pkey PRIMARY KEY (code);


--
-- Name: user_session user_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_session
    ADD CONSTRAINT user_session_pkey PRIMARY KEY (id);


--
-- Name: validation_report validation_report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_report
    ADD CONSTRAINT validation_report_pkey PRIMARY KEY (id);


--
-- Name: workflow_definition workflow_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definition
    ADD CONSTRAINT workflow_definition_pkey PRIMARY KEY (id);


--
-- Name: workflow_definition workflow_definition_request_type_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definition
    ADD CONSTRAINT workflow_definition_request_type_code_key UNIQUE (request_type_code);


--
-- Name: workflow_version workflow_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_version
    ADD CONSTRAINT workflow_version_pkey PRIMARY KEY (id);


--
-- Name: workflow_version workflow_version_workflow_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_version
    ADD CONSTRAINT workflow_version_workflow_id_version_key UNIQUE (workflow_id, version);


--
-- Name: access_policy_one_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX access_policy_one_draft ON public.access_policy_version USING btree ((true)) WHERE (status = 'DRAFT'::text);


--
-- Name: access_policy_one_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX access_policy_one_published ON public.access_policy_version USING btree ((true)) WHERE (status = 'PUBLISHED'::text);


--
-- Name: act_idx_act_hi_tsk_log_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_act_hi_tsk_log_task ON public.act_hi_tsk_log USING btree (task_id_);


--
-- Name: act_idx_athrz_procedef; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_athrz_procedef ON public.act_ru_identitylink USING btree (proc_def_id_);


--
-- Name: act_idx_bytear_depl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_bytear_depl ON public.act_ge_bytearray USING btree (deployment_id_);


--
-- Name: act_idx_channel_def_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX act_idx_channel_def_uniq ON public.flw_channel_definition USING btree (key_, version_, tenant_id_);


--
-- Name: act_idx_deadletter_job_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_correlation_id ON public.act_ru_deadletter_job USING btree (correlation_id_);


--
-- Name: act_idx_deadletter_job_custom_values_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_custom_values_id ON public.act_ru_deadletter_job USING btree (custom_values_id_);


--
-- Name: act_idx_deadletter_job_exception_stack_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_exception_stack_id ON public.act_ru_deadletter_job USING btree (exception_stack_id_);


--
-- Name: act_idx_deadletter_job_execution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_execution_id ON public.act_ru_deadletter_job USING btree (execution_id_);


--
-- Name: act_idx_deadletter_job_proc_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_proc_def_id ON public.act_ru_deadletter_job USING btree (proc_def_id_);


--
-- Name: act_idx_deadletter_job_process_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_deadletter_job_process_instance_id ON public.act_ru_deadletter_job USING btree (process_instance_id_);


--
-- Name: act_idx_djob_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_djob_scope ON public.act_ru_deadletter_job USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_djob_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_djob_scope_def ON public.act_ru_deadletter_job USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_djob_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_djob_sub_scope ON public.act_ru_deadletter_job USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_ejob_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ejob_scope ON public.act_ru_external_job USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_ejob_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ejob_scope_def ON public.act_ru_external_job USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_ejob_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ejob_sub_scope ON public.act_ru_external_job USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_ent_lnk_ref_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ent_lnk_ref_scope ON public.act_ru_entitylink USING btree (ref_scope_id_, ref_scope_type_, link_type_);


--
-- Name: act_idx_ent_lnk_root_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ent_lnk_root_scope ON public.act_ru_entitylink USING btree (root_scope_id_, root_scope_type_, link_type_);


--
-- Name: act_idx_ent_lnk_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ent_lnk_scope ON public.act_ru_entitylink USING btree (scope_id_, scope_type_, link_type_);


--
-- Name: act_idx_ent_lnk_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ent_lnk_scope_def ON public.act_ru_entitylink USING btree (scope_definition_id_, scope_type_, link_type_);


--
-- Name: act_idx_event_def_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX act_idx_event_def_uniq ON public.flw_event_definition USING btree (key_, version_, tenant_id_);


--
-- Name: act_idx_event_subscr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_event_subscr ON public.act_ru_event_subscr USING btree (execution_id_);


--
-- Name: act_idx_event_subscr_config_; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_event_subscr_config_ ON public.act_ru_event_subscr USING btree (configuration_);


--
-- Name: act_idx_event_subscr_proc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_event_subscr_proc_id ON public.act_ru_event_subscr USING btree (proc_inst_id_);


--
-- Name: act_idx_event_subscr_scoperef_; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_event_subscr_scoperef_ ON public.act_ru_event_subscr USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_exe_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exe_parent ON public.act_ru_execution USING btree (parent_id_);


--
-- Name: act_idx_exe_procdef; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exe_procdef ON public.act_ru_execution USING btree (proc_def_id_);


--
-- Name: act_idx_exe_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exe_procinst ON public.act_ru_execution USING btree (proc_inst_id_);


--
-- Name: act_idx_exe_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exe_root ON public.act_ru_execution USING btree (root_proc_inst_id_);


--
-- Name: act_idx_exe_super; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exe_super ON public.act_ru_execution USING btree (super_exec_);


--
-- Name: act_idx_exec_buskey; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exec_buskey ON public.act_ru_execution USING btree (business_key_);


--
-- Name: act_idx_exec_ref_id_; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_exec_ref_id_ ON public.act_ru_execution USING btree (reference_id_);


--
-- Name: act_idx_external_job_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_external_job_correlation_id ON public.act_ru_external_job USING btree (correlation_id_);


--
-- Name: act_idx_external_job_custom_values_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_external_job_custom_values_id ON public.act_ru_external_job USING btree (custom_values_id_);


--
-- Name: act_idx_external_job_exception_stack_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_external_job_exception_stack_id ON public.act_ru_external_job USING btree (exception_stack_id_);


--
-- Name: act_idx_hi_act_inst_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_act_inst_end ON public.act_hi_actinst USING btree (end_time_);


--
-- Name: act_idx_hi_act_inst_exec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_act_inst_exec ON public.act_hi_actinst USING btree (execution_id_, act_id_);


--
-- Name: act_idx_hi_act_inst_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_act_inst_procinst ON public.act_hi_actinst USING btree (proc_inst_id_, act_id_);


--
-- Name: act_idx_hi_act_inst_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_act_inst_start ON public.act_hi_actinst USING btree (start_time_);


--
-- Name: act_idx_hi_detail_act_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_detail_act_inst ON public.act_hi_detail USING btree (act_inst_id_);


--
-- Name: act_idx_hi_detail_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_detail_name ON public.act_hi_detail USING btree (name_);


--
-- Name: act_idx_hi_detail_proc_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_detail_proc_inst ON public.act_hi_detail USING btree (proc_inst_id_);


--
-- Name: act_idx_hi_detail_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_detail_task_id ON public.act_hi_detail USING btree (task_id_);


--
-- Name: act_idx_hi_detail_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_detail_time ON public.act_hi_detail USING btree (time_);


--
-- Name: act_idx_hi_ent_lnk_ref_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ent_lnk_ref_scope ON public.act_hi_entitylink USING btree (ref_scope_id_, ref_scope_type_, link_type_);


--
-- Name: act_idx_hi_ent_lnk_root_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ent_lnk_root_scope ON public.act_hi_entitylink USING btree (root_scope_id_, root_scope_type_, link_type_);


--
-- Name: act_idx_hi_ent_lnk_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ent_lnk_scope ON public.act_hi_entitylink USING btree (scope_id_, scope_type_, link_type_);


--
-- Name: act_idx_hi_ent_lnk_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ent_lnk_scope_def ON public.act_hi_entitylink USING btree (scope_definition_id_, scope_type_, link_type_);


--
-- Name: act_idx_hi_ident_lnk_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_procinst ON public.act_hi_identitylink USING btree (proc_inst_id_);


--
-- Name: act_idx_hi_ident_lnk_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_scope ON public.act_hi_identitylink USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_hi_ident_lnk_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_scope_def ON public.act_hi_identitylink USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_hi_ident_lnk_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_sub_scope ON public.act_hi_identitylink USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_hi_ident_lnk_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_task ON public.act_hi_identitylink USING btree (task_id_);


--
-- Name: act_idx_hi_ident_lnk_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_ident_lnk_user ON public.act_hi_identitylink USING btree (user_id_);


--
-- Name: act_idx_hi_pro_i_buskey; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_pro_i_buskey ON public.act_hi_procinst USING btree (business_key_);


--
-- Name: act_idx_hi_pro_inst_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_pro_inst_end ON public.act_hi_procinst USING btree (end_time_);


--
-- Name: act_idx_hi_pro_super_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_pro_super_procinst ON public.act_hi_procinst USING btree (super_process_instance_id_);


--
-- Name: act_idx_hi_procvar_exe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_procvar_exe ON public.act_hi_varinst USING btree (execution_id_);


--
-- Name: act_idx_hi_procvar_name_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_procvar_name_type ON public.act_hi_varinst USING btree (name_, var_type_);


--
-- Name: act_idx_hi_procvar_proc_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_procvar_proc_inst ON public.act_hi_varinst USING btree (proc_inst_id_);


--
-- Name: act_idx_hi_procvar_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_procvar_task_id ON public.act_hi_varinst USING btree (task_id_);


--
-- Name: act_idx_hi_task_inst_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_task_inst_procinst ON public.act_hi_taskinst USING btree (proc_inst_id_);


--
-- Name: act_idx_hi_task_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_task_scope ON public.act_hi_taskinst USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_hi_task_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_task_scope_def ON public.act_hi_taskinst USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_hi_task_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_task_sub_scope ON public.act_hi_taskinst USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_hi_var_scope_id_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_var_scope_id_type ON public.act_hi_varinst USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_hi_var_sub_id_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_hi_var_sub_id_type ON public.act_hi_varinst USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_ident_lnk_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ident_lnk_group ON public.act_ru_identitylink USING btree (group_id_);


--
-- Name: act_idx_ident_lnk_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ident_lnk_scope ON public.act_ru_identitylink USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_ident_lnk_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ident_lnk_scope_def ON public.act_ru_identitylink USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_ident_lnk_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ident_lnk_sub_scope ON public.act_ru_identitylink USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_ident_lnk_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ident_lnk_user ON public.act_ru_identitylink USING btree (user_id_);


--
-- Name: act_idx_idl_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_idl_procinst ON public.act_ru_identitylink USING btree (proc_inst_id_);


--
-- Name: act_idx_job_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_correlation_id ON public.act_ru_job USING btree (correlation_id_);


--
-- Name: act_idx_job_custom_values_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_custom_values_id ON public.act_ru_job USING btree (custom_values_id_);


--
-- Name: act_idx_job_exception_stack_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_exception_stack_id ON public.act_ru_job USING btree (exception_stack_id_);


--
-- Name: act_idx_job_execution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_execution_id ON public.act_ru_job USING btree (execution_id_);


--
-- Name: act_idx_job_proc_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_proc_def_id ON public.act_ru_job USING btree (proc_def_id_);


--
-- Name: act_idx_job_process_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_process_instance_id ON public.act_ru_job USING btree (process_instance_id_);


--
-- Name: act_idx_job_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_scope ON public.act_ru_job USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_job_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_scope_def ON public.act_ru_job USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_job_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_job_sub_scope ON public.act_ru_job USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_memb_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_memb_group ON public.act_id_membership USING btree (group_id_);


--
-- Name: act_idx_memb_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_memb_user ON public.act_id_membership USING btree (user_id_);


--
-- Name: act_idx_model_deployment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_model_deployment ON public.act_re_model USING btree (deployment_id_);


--
-- Name: act_idx_model_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_model_source ON public.act_re_model USING btree (editor_source_value_id_);


--
-- Name: act_idx_model_source_extra; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_model_source_extra ON public.act_re_model USING btree (editor_source_extra_value_id_);


--
-- Name: act_idx_priv_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_priv_group ON public.act_id_priv_mapping USING btree (group_id_);


--
-- Name: act_idx_priv_mapping; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_priv_mapping ON public.act_id_priv_mapping USING btree (priv_id_);


--
-- Name: act_idx_priv_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_priv_user ON public.act_id_priv_mapping USING btree (user_id_);


--
-- Name: act_idx_procdef_info_json; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_procdef_info_json ON public.act_procdef_info USING btree (info_json_id_);


--
-- Name: act_idx_procdef_info_proc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_procdef_info_proc ON public.act_procdef_info USING btree (proc_def_id_);


--
-- Name: act_idx_ru_acti_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_end ON public.act_ru_actinst USING btree (end_time_);


--
-- Name: act_idx_ru_acti_exec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_exec ON public.act_ru_actinst USING btree (execution_id_);


--
-- Name: act_idx_ru_acti_exec_act; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_exec_act ON public.act_ru_actinst USING btree (execution_id_, act_id_);


--
-- Name: act_idx_ru_acti_proc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_proc ON public.act_ru_actinst USING btree (proc_inst_id_);


--
-- Name: act_idx_ru_acti_proc_act; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_proc_act ON public.act_ru_actinst USING btree (proc_inst_id_, act_id_);


--
-- Name: act_idx_ru_acti_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_start ON public.act_ru_actinst USING btree (start_time_);


--
-- Name: act_idx_ru_acti_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_acti_task ON public.act_ru_actinst USING btree (task_id_);


--
-- Name: act_idx_ru_var_scope_id_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_var_scope_id_type ON public.act_ru_variable USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_ru_var_sub_id_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_ru_var_sub_id_type ON public.act_ru_variable USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_sjob_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_sjob_scope ON public.act_ru_suspended_job USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_sjob_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_sjob_scope_def ON public.act_ru_suspended_job USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_sjob_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_sjob_sub_scope ON public.act_ru_suspended_job USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_suspended_job_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_correlation_id ON public.act_ru_suspended_job USING btree (correlation_id_);


--
-- Name: act_idx_suspended_job_custom_values_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_custom_values_id ON public.act_ru_suspended_job USING btree (custom_values_id_);


--
-- Name: act_idx_suspended_job_exception_stack_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_exception_stack_id ON public.act_ru_suspended_job USING btree (exception_stack_id_);


--
-- Name: act_idx_suspended_job_execution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_execution_id ON public.act_ru_suspended_job USING btree (execution_id_);


--
-- Name: act_idx_suspended_job_proc_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_proc_def_id ON public.act_ru_suspended_job USING btree (proc_def_id_);


--
-- Name: act_idx_suspended_job_process_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_suspended_job_process_instance_id ON public.act_ru_suspended_job USING btree (process_instance_id_);


--
-- Name: act_idx_task_create; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_create ON public.act_ru_task USING btree (create_time_);


--
-- Name: act_idx_task_exec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_exec ON public.act_ru_task USING btree (execution_id_);


--
-- Name: act_idx_task_procdef; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_procdef ON public.act_ru_task USING btree (proc_def_id_);


--
-- Name: act_idx_task_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_procinst ON public.act_ru_task USING btree (proc_inst_id_);


--
-- Name: act_idx_task_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_scope ON public.act_ru_task USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_task_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_scope_def ON public.act_ru_task USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_task_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_task_sub_scope ON public.act_ru_task USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_timer_job_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_correlation_id ON public.act_ru_timer_job USING btree (correlation_id_);


--
-- Name: act_idx_timer_job_custom_values_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_custom_values_id ON public.act_ru_timer_job USING btree (custom_values_id_);


--
-- Name: act_idx_timer_job_duedate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_duedate ON public.act_ru_timer_job USING btree (duedate_);


--
-- Name: act_idx_timer_job_exception_stack_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_exception_stack_id ON public.act_ru_timer_job USING btree (exception_stack_id_);


--
-- Name: act_idx_timer_job_execution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_execution_id ON public.act_ru_timer_job USING btree (execution_id_);


--
-- Name: act_idx_timer_job_proc_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_proc_def_id ON public.act_ru_timer_job USING btree (proc_def_id_);


--
-- Name: act_idx_timer_job_process_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_timer_job_process_instance_id ON public.act_ru_timer_job USING btree (process_instance_id_);


--
-- Name: act_idx_tjob_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_tjob_scope ON public.act_ru_timer_job USING btree (scope_id_, scope_type_);


--
-- Name: act_idx_tjob_scope_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_tjob_scope_def ON public.act_ru_timer_job USING btree (scope_definition_id_, scope_type_);


--
-- Name: act_idx_tjob_sub_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_tjob_sub_scope ON public.act_ru_timer_job USING btree (sub_scope_id_, scope_type_);


--
-- Name: act_idx_tskass_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_tskass_task ON public.act_ru_identitylink USING btree (task_id_);


--
-- Name: act_idx_var_bytearray; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_var_bytearray ON public.act_ru_variable USING btree (bytearray_id_);


--
-- Name: act_idx_var_exe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_var_exe ON public.act_ru_variable USING btree (execution_id_);


--
-- Name: act_idx_var_procinst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_var_procinst ON public.act_ru_variable USING btree (proc_inst_id_);


--
-- Name: act_idx_variable_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX act_idx_variable_task_id ON public.act_ru_variable USING btree (task_id_);


--
-- Name: affiliation_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX affiliation_open_idx ON public.affiliation USING btree (person_id) WHERE (valid_to IS NULL);


--
-- Name: affiliation_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliation_org_idx ON public.affiliation USING btree (organization_id, position_id) WHERE (valid_to IS NULL);


--
-- Name: attachment_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachment_request_idx ON public.attachment USING btree (request_id, field_id);


--
-- Name: audit_event_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_event_entity_idx ON public.audit_event USING btree (entity_type, entity_id);


--
-- Name: audit_event_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_event_time_idx ON public.audit_event USING btree (occurred_at DESC);


--
-- Name: authz_change_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authz_change_person_idx ON public.authz_change USING btree (person_id, seq);


--
-- Name: authz_tuple_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authz_tuple_person_idx ON public.authz_tuple USING btree (person_id) WHERE (person_id IS NOT NULL);


--
-- Name: decision_communication_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX decision_communication_request ON public.decision_communication USING btree (request_id, communicated_at);


--
-- Name: decision_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX decision_request_idx ON public.decision USING btree (request_id);


--
-- Name: delegation_delegate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_delegate_idx ON public.delegation USING btree (delegate_id);


--
-- Name: deployment_area_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployment_area_geom_idx ON public.deployment_area USING gist (geom) WHERE (state = 'ACTIVE'::text);


--
-- Name: execution_task_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_task_request_idx ON public.execution_task USING btree (request_id);


--
-- Name: flw_idx_batch_part; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flw_idx_batch_part ON public.flw_ru_batch_part USING btree (batch_id_);


--
-- Name: flw_idx_event_rsrc_dpl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flw_idx_event_rsrc_dpl ON public.flw_event_resource USING btree (deployment_id_);


--
-- Name: flyway_schema_history_s_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flyway_schema_history_s_idx ON public.flyway_schema_history USING btree (success);


--
-- Name: form_version_single_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_version_single_draft ON public.form_version USING btree (form_id) WHERE (status = 'DRAFT'::text);


--
-- Name: hr_mapping_one_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_mapping_one_draft ON public.hr_mapping_version USING btree (source_id) WHERE (status = 'DRAFT'::text);


--
-- Name: hr_mapping_one_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_mapping_one_published ON public.hr_mapping_version USING btree (source_id) WHERE (status = 'PUBLISHED'::text);


--
-- Name: hr_person_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_person_account_idx ON public.hr_person USING btree (snapshot_id, lower(domain_account));


--
-- Name: hr_person_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_person_number_idx ON public.hr_person USING btree (snapshot_id, employee_number);


--
-- Name: hr_person_unit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_person_unit_idx ON public.hr_person USING btree (snapshot_id, unit_external_id);


--
-- Name: hr_snapshot_one_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_snapshot_one_published ON public.hr_snapshot USING btree ((true)) WHERE (status = 'PUBLISHED'::text);


--
-- Name: hr_sync_issue_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_sync_issue_run_idx ON public.hr_sync_issue USING btree (run_id);


--
-- Name: hr_sync_run_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_sync_run_started_idx ON public.hr_sync_run USING btree (started_at DESC);


--
-- Name: hr_unit_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_unit_parent_idx ON public.hr_unit USING btree (snapshot_id, parent_external_id);


--
-- Name: identity_link_issue_linked_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_link_issue_linked_key_idx ON public.identity_link_issue USING btree (lower(claimed_key)) WHERE ((resolution = 'LINKED'::text) AND (claimed_key IS NOT NULL));


--
-- Name: identity_link_issue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX identity_link_issue_open ON public.identity_link_issue USING btree (issuer, subject) WHERE (resolved_at IS NULL);


--
-- Name: identity_link_issue_resolved_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_link_issue_resolved_person_idx ON public.identity_link_issue USING btree (resolved_person_id) WHERE (resolution = 'LINKED'::text);


--
-- Name: map_import_job_creator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX map_import_job_creator_idx ON public.map_import_job USING btree (created_by, created_at DESC);


--
-- Name: membership_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_org_idx ON public.membership USING btree (organization_id);


--
-- Name: membership_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_person_idx ON public.membership USING btree (person_id);


--
-- Name: notification_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_person_idx ON public.notification USING btree (person_id, created_at DESC);


--
-- Name: org_stationing_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_stationing_org_idx ON public.org_stationing USING btree (organization_id, valid_from);


--
-- Name: org_stationing_site_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_stationing_site_idx ON public.org_stationing USING btree (site_id) WHERE (valid_to IS NULL);


--
-- Name: organization_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_parent_idx ON public.organization USING btree (parent_id);


--
-- Name: organization_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX organization_source_idx ON public.organization USING btree (source, source_external_id) WHERE (source_external_id IS NOT NULL);


--
-- Name: outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending_idx ON public.outbox_event USING btree (available_at, id) WHERE (delivery_state = 'PENDING'::text);


--
-- Name: person_employee_no_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX person_employee_no_lower_idx ON public.person USING btree (lower(employee_no));


--
-- Name: person_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX person_name_idx ON public.person USING btree (lower(display_name));


--
-- Name: person_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX person_source_idx ON public.person USING btree (source, source_external_id) WHERE (source_external_id IS NOT NULL);


--
-- Name: person_username_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX person_username_lower_idx ON public.person USING btree (lower(username)) WHERE (username IS NOT NULL);


--
-- Name: placement_rule_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX placement_rule_action_idx ON public.placement_rule USING btree (action) WHERE active;


--
-- Name: request_creator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_creator_idx ON public.request USING btree (created_by);


--
-- Name: request_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_owner_idx ON public.request USING btree (owner_org_id);


--
-- Name: request_participant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_participant_org_idx ON public.request_participant USING btree (organization_id);


--
-- Name: request_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_period_idx ON public.request USING gist (tstzrange(period_start, period_end, '[)'::text));


--
-- Name: request_relocation_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_relocation_geom ON public.request_relocation USING gist (proposed_geom);


--
-- Name: request_resource_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_resource_resource_idx ON public.request_resource USING btree (resource_id);


--
-- Name: request_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_status_idx ON public.request USING btree (status);


--
-- Name: reservation_lock_reservation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reservation_lock_reservation_idx ON public.reservation_lock USING btree (reservation_id);


--
-- Name: reservation_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reservation_period_idx ON public.reservation USING gist (tstzrange(period_start, period_end, '[)'::text));


--
-- Name: reservation_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reservation_resource_idx ON public.reservation USING btree (resource_id);


--
-- Name: resource_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_parent_idx ON public.resource USING btree (parent_resource_id);


--
-- Name: resource_site_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_site_idx ON public.resource USING btree (site_id);


--
-- Name: restationing_action_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX restationing_action_open_idx ON public.restationing_action USING btree (request_id) WHERE (state = 'REQUESTED'::text);


--
-- Name: restationing_action_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restationing_action_request_idx ON public.restationing_action USING btree (request_id, requested_at);


--
-- Name: restationing_request_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restationing_request_due_idx ON public.restationing_request USING btree (state, start_at, end_at) WHERE (state = ANY (ARRAY['TEMPORARY_SCHEDULED'::text, 'START_HELD_PENDING_CANCELLATION'::text, 'ACTIVE_TEMPORARY'::text]));


--
-- Name: restationing_request_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restationing_request_parent_idx ON public.restationing_request USING btree (parent_request_id) WHERE (parent_request_id IS NOT NULL);


--
-- Name: restationing_request_unit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restationing_request_unit_idx ON public.restationing_request USING btree (requesting_unit_id, state);


--
-- Name: signing_job_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX signing_job_once ON public.signing_job USING btree (task_id, signer_person_id, revision, document_sha256) WHERE (status = ANY (ARRAY['PENDING'::text, 'SIGNED'::text, 'PUBLISHED'::text]));


--
-- Name: signing_job_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signing_job_request_idx ON public.signing_job USING btree (request_id);


--
-- Name: site_geometry_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX site_geometry_geom_idx ON public.site_geometry_version USING gist (geom);


--
-- Name: site_link_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX site_link_open_idx ON public.site_link USING btree (site_id, organization_id) WHERE (valid_to IS NULL);


--
-- Name: site_marker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX site_marker_idx ON public.site USING gist (marker);


--
-- Name: site_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX site_parent_idx ON public.site USING btree (parent_id);


--
-- Name: site_responsibility_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX site_responsibility_current_idx ON public.site_responsibility USING btree (site_id) WHERE (valid_to IS NULL);


--
-- Name: stationing_outbox_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stationing_outbox_due_idx ON public.stationing_outbox USING btree (available_at, seq) WHERE (state = 'PENDING'::text);


--
-- Name: stationing_outbox_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stationing_outbox_org_idx ON public.stationing_outbox USING btree (organization_id, seq) WHERE (state <> 'DELIVERED'::text);


--
-- Name: task_assignment_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_assignment_open_idx ON public.task_assignment USING btree (role_code, due_at) WHERE (status = 'OPEN'::text);


--
-- Name: task_assignment_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_assignment_request_idx ON public.task_assignment USING btree (request_id);


--
-- Name: task_reassignment_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_reassignment_open_idx ON public.task_reassignment USING btree (outcome) WHERE (resolved_at IS NULL);


--
-- Name: task_reassignment_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_reassignment_org_idx ON public.task_reassignment USING btree (routed_to_org) WHERE (resolved_at IS NULL);


--
-- Name: terrain_slope_dataset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terrain_slope_dataset_idx ON public.terrain_slope USING btree (dataset_id);


--
-- Name: terrain_slope_hull; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terrain_slope_hull ON public.terrain_slope USING gist (public.st_convexhull(rast));


--
-- Name: user_session_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_session_person_idx ON public.user_session USING btree (person_id);


--
-- Name: workflow_version_single_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_version_single_draft ON public.workflow_version USING btree (workflow_id) WHERE (status = 'DRAFT'::text);


--
-- Name: access_policy_version access_policy_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER access_policy_version_immutable BEFORE DELETE OR UPDATE ON public.access_policy_version FOR EACH ROW EXECUTE FUNCTION public.access_policy_version_guard();


--
-- Name: affiliation affiliation_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER affiliation_authz AFTER INSERT OR DELETE OR UPDATE ON public.affiliation FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('grants');


--
-- Name: approval_document approval_document_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_document_append_only BEFORE DELETE OR UPDATE ON public.approval_document FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: audit_event audit_event_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_event_append_only BEFORE DELETE OR UPDATE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: audit_event audit_event_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON public.audit_event FOR EACH STATEMENT EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: decision decision_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER decision_append_only BEFORE DELETE OR UPDATE ON public.decision FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: decision_communication decision_communication_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER decision_communication_append_only BEFORE DELETE OR UPDATE ON public.decision_communication FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: delegation delegation_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delegation_authz AFTER INSERT OR UPDATE ON public.delegation FOR EACH ROW EXECUTE FUNCTION public.authz_note_person();


--
-- Name: form_version form_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER form_version_immutable BEFORE DELETE OR UPDATE ON public.form_version FOR EACH ROW EXECUTE FUNCTION public.mover_published_immutable();


--
-- Name: hr_mapping_version hr_mapping_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hr_mapping_immutable BEFORE UPDATE ON public.hr_mapping_version FOR EACH ROW EXECUTE FUNCTION public.hr_mapping_immutable();


--
-- Name: membership membership_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER membership_authz AFTER INSERT OR UPDATE ON public.membership FOR EACH ROW EXECUTE FUNCTION public.authz_note_person();


--
-- Name: membership_scope_target membership_scope_target_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER membership_scope_target_authz AFTER INSERT ON public.membership_scope_target FOR EACH ROW EXECUTE FUNCTION public.authz_note_person();


--
-- Name: membership_scope_target membership_scope_target_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER membership_scope_target_no_update BEFORE DELETE OR UPDATE ON public.membership_scope_target FOR EACH ROW EXECUTE FUNCTION public.membership_scope_target_frozen();


--
-- Name: organization organization_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organization_authz AFTER INSERT OR UPDATE OF parent_id ON public.organization FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('structure');


--
-- Name: organization organization_hr_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organization_hr_read_only BEFORE UPDATE ON public.organization FOR EACH ROW EXECUTE FUNCTION public.organization_hr_read_only();


--
-- Name: organization organization_no_cycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organization_no_cycle BEFORE INSERT OR UPDATE OF parent_id ON public.organization FOR EACH ROW EXECUTE FUNCTION public.organization_no_cycle();


--
-- Name: organization organization_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organization_no_delete BEFORE DELETE ON public.organization FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_delete();


--
-- Name: organization organization_status_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organization_status_authz AFTER UPDATE OF status ON public.organization FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('grants');


--
-- Name: person person_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER person_authz AFTER UPDATE OF status ON public.person FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('grants');


--
-- Name: person person_hr_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER person_hr_read_only BEFORE UPDATE ON public.person FOR EACH ROW EXECUTE FUNCTION public.person_hr_read_only();


--
-- Name: policy_version policy_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER policy_version_immutable BEFORE DELETE OR UPDATE ON public.policy_version FOR EACH ROW EXECUTE FUNCTION public.mover_published_immutable();


--
-- Name: position_seat position_seat_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER position_seat_authz AFTER INSERT OR UPDATE ON public.position_seat FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('grants');


--
-- Name: request_revision request_revision_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER request_revision_append_only BEFORE DELETE OR UPDATE ON public.request_revision FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: reservation_change reservation_change_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reservation_change_append_only BEFORE DELETE OR UPDATE ON public.reservation_change FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: resource resource_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_authz AFTER INSERT OR UPDATE OF site_id ON public.resource FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('structure');


--
-- Name: resource resource_no_cycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_no_cycle BEFORE INSERT OR UPDATE OF parent_resource_id ON public.resource FOR EACH ROW EXECUTE FUNCTION public.resource_no_cycle();


--
-- Name: resource resource_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_no_delete BEFORE DELETE ON public.resource FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_delete();


--
-- Name: role_def role_def_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER role_def_authz AFTER INSERT OR UPDATE ON public.role_def FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('grants');


--
-- Name: signature_evidence signature_evidence_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signature_evidence_append_only BEFORE DELETE OR UPDATE ON public.signature_evidence FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: site site_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_authz AFTER INSERT OR UPDATE OF parent_id ON public.site FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('structure');


--
-- Name: site_geometry_version site_geometry_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_geometry_append_only BEFORE DELETE OR UPDATE ON public.site_geometry_version FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: site_geometry_version site_geometry_fill; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_geometry_fill BEFORE INSERT ON public.site_geometry_version FOR EACH ROW EXECUTE FUNCTION public.site_geometry_fill();


--
-- Name: site site_no_cycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_no_cycle BEFORE INSERT OR UPDATE OF parent_id ON public.site FOR EACH ROW EXECUTE FUNCTION public.site_no_cycle();


--
-- Name: site site_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_no_delete BEFORE DELETE ON public.site FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_delete();


--
-- Name: site_responsibility site_responsibility_authz; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER site_responsibility_authz AFTER INSERT OR UPDATE ON public.site_responsibility FOR EACH STATEMENT EXECUTE FUNCTION public.authz_note_shared('structure');


--
-- Name: stationing_policy_version stationing_policy_version_frozen; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stationing_policy_version_frozen BEFORE DELETE OR UPDATE ON public.stationing_policy_version FOR EACH ROW EXECUTE FUNCTION public.stationing_policy_version_append_only();


--
-- Name: validation_report validation_report_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validation_report_append_only BEFORE DELETE OR UPDATE ON public.validation_report FOR EACH ROW EXECUTE FUNCTION public.mover_forbid_change();


--
-- Name: workflow_version workflow_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_version_immutable BEFORE DELETE OR UPDATE ON public.workflow_version FOR EACH ROW EXECUTE FUNCTION public.mover_published_immutable();


--
-- Name: access_policy_version access_policy_version_based_on_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_based_on_fkey FOREIGN KEY (based_on) REFERENCES public.access_policy_version(id);


--
-- Name: access_policy_version access_policy_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: access_policy_version access_policy_version_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.person(id);


--
-- Name: access_policy_version access_policy_version_restored_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_policy_version
    ADD CONSTRAINT access_policy_version_restored_from_fkey FOREIGN KEY (restored_from) REFERENCES public.access_policy_version(id);


--
-- Name: act_ru_identitylink act_fk_athrz_procedef; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_identitylink
    ADD CONSTRAINT act_fk_athrz_procedef FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ge_bytearray act_fk_bytearr_depl; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ge_bytearray
    ADD CONSTRAINT act_fk_bytearr_depl FOREIGN KEY (deployment_id_) REFERENCES public.act_re_deployment(id_);


--
-- Name: act_ru_deadletter_job act_fk_deadletter_job_custom_values; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_fk_deadletter_job_custom_values FOREIGN KEY (custom_values_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_deadletter_job act_fk_deadletter_job_exception; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_fk_deadletter_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_deadletter_job act_fk_deadletter_job_execution; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_fk_deadletter_job_execution FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_deadletter_job act_fk_deadletter_job_proc_def; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_fk_deadletter_job_proc_def FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_deadletter_job act_fk_deadletter_job_process_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_deadletter_job
    ADD CONSTRAINT act_fk_deadletter_job_process_instance FOREIGN KEY (process_instance_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_event_subscr act_fk_event_exec; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_event_subscr
    ADD CONSTRAINT act_fk_event_exec FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_execution act_fk_exe_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_execution
    ADD CONSTRAINT act_fk_exe_parent FOREIGN KEY (parent_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_execution act_fk_exe_procdef; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_execution
    ADD CONSTRAINT act_fk_exe_procdef FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_execution act_fk_exe_procinst; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_execution
    ADD CONSTRAINT act_fk_exe_procinst FOREIGN KEY (proc_inst_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_execution act_fk_exe_super; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_execution
    ADD CONSTRAINT act_fk_exe_super FOREIGN KEY (super_exec_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_external_job act_fk_external_job_custom_values; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_external_job
    ADD CONSTRAINT act_fk_external_job_custom_values FOREIGN KEY (custom_values_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_external_job act_fk_external_job_exception; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_external_job
    ADD CONSTRAINT act_fk_external_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_identitylink act_fk_idl_procinst; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_identitylink
    ADD CONSTRAINT act_fk_idl_procinst FOREIGN KEY (proc_inst_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_procdef_info act_fk_info_json_ba; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_procdef_info
    ADD CONSTRAINT act_fk_info_json_ba FOREIGN KEY (info_json_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_procdef_info act_fk_info_procdef; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_procdef_info
    ADD CONSTRAINT act_fk_info_procdef FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_job act_fk_job_custom_values; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_fk_job_custom_values FOREIGN KEY (custom_values_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_job act_fk_job_exception; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_fk_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_job act_fk_job_execution; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_fk_job_execution FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_job act_fk_job_proc_def; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_fk_job_proc_def FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_job act_fk_job_process_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_job
    ADD CONSTRAINT act_fk_job_process_instance FOREIGN KEY (process_instance_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_id_membership act_fk_memb_group; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_membership
    ADD CONSTRAINT act_fk_memb_group FOREIGN KEY (group_id_) REFERENCES public.act_id_group(id_);


--
-- Name: act_id_membership act_fk_memb_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_membership
    ADD CONSTRAINT act_fk_memb_user FOREIGN KEY (user_id_) REFERENCES public.act_id_user(id_);


--
-- Name: act_re_model act_fk_model_deployment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_model
    ADD CONSTRAINT act_fk_model_deployment FOREIGN KEY (deployment_id_) REFERENCES public.act_re_deployment(id_);


--
-- Name: act_re_model act_fk_model_source; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_model
    ADD CONSTRAINT act_fk_model_source FOREIGN KEY (editor_source_value_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_re_model act_fk_model_source_extra; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_re_model
    ADD CONSTRAINT act_fk_model_source_extra FOREIGN KEY (editor_source_extra_value_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_id_priv_mapping act_fk_priv_mapping; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_id_priv_mapping
    ADD CONSTRAINT act_fk_priv_mapping FOREIGN KEY (priv_id_) REFERENCES public.act_id_priv(id_);


--
-- Name: act_ru_suspended_job act_fk_suspended_job_custom_values; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_fk_suspended_job_custom_values FOREIGN KEY (custom_values_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_suspended_job act_fk_suspended_job_exception; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_fk_suspended_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_suspended_job act_fk_suspended_job_execution; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_fk_suspended_job_execution FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_suspended_job act_fk_suspended_job_proc_def; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_fk_suspended_job_proc_def FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_suspended_job act_fk_suspended_job_process_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_suspended_job
    ADD CONSTRAINT act_fk_suspended_job_process_instance FOREIGN KEY (process_instance_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_task act_fk_task_exe; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_task
    ADD CONSTRAINT act_fk_task_exe FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_task act_fk_task_procdef; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_task
    ADD CONSTRAINT act_fk_task_procdef FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_task act_fk_task_procinst; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_task
    ADD CONSTRAINT act_fk_task_procinst FOREIGN KEY (proc_inst_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_timer_job act_fk_timer_job_custom_values; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_fk_timer_job_custom_values FOREIGN KEY (custom_values_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_timer_job act_fk_timer_job_exception; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_fk_timer_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_timer_job act_fk_timer_job_execution; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_fk_timer_job_execution FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_timer_job act_fk_timer_job_proc_def; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_fk_timer_job_proc_def FOREIGN KEY (proc_def_id_) REFERENCES public.act_re_procdef(id_);


--
-- Name: act_ru_timer_job act_fk_timer_job_process_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_timer_job
    ADD CONSTRAINT act_fk_timer_job_process_instance FOREIGN KEY (process_instance_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_identitylink act_fk_tskass_task; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_identitylink
    ADD CONSTRAINT act_fk_tskass_task FOREIGN KEY (task_id_) REFERENCES public.act_ru_task(id_);


--
-- Name: act_ru_variable act_fk_var_bytearray; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_variable
    ADD CONSTRAINT act_fk_var_bytearray FOREIGN KEY (bytearray_id_) REFERENCES public.act_ge_bytearray(id_);


--
-- Name: act_ru_variable act_fk_var_exe; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_variable
    ADD CONSTRAINT act_fk_var_exe FOREIGN KEY (execution_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: act_ru_variable act_fk_var_procinst; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.act_ru_variable
    ADD CONSTRAINT act_fk_var_procinst FOREIGN KEY (proc_inst_id_) REFERENCES public.act_ru_execution(id_);


--
-- Name: affiliation affiliation_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliation
    ADD CONSTRAINT affiliation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: affiliation affiliation_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliation
    ADD CONSTRAINT affiliation_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: approval_document approval_document_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_document
    ADD CONSTRAINT approval_document_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decision(id);


--
-- Name: approval_document approval_document_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_document
    ADD CONSTRAINT approval_document_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: approval_document approval_document_signer_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_document
    ADD CONSTRAINT approval_document_signer_person_id_fkey FOREIGN KEY (signer_person_id) REFERENCES public.person(id);


--
-- Name: approval_document approval_document_signing_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_document
    ADD CONSTRAINT approval_document_signing_job_id_fkey FOREIGN KEY (signing_job_id) REFERENCES public.signing_job(id);


--
-- Name: attachment attachment_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: attachment attachment_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.attachment(id);


--
-- Name: attachment attachment_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.person(id);


--
-- Name: bootstrap_admin bootstrap_admin_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bootstrap_admin
    ADD CONSTRAINT bootstrap_admin_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: decision decision_actor_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_actor_org_id_fkey FOREIGN KEY (actor_org_id) REFERENCES public.organization(id);


--
-- Name: decision decision_actor_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_actor_person_id_fkey FOREIGN KEY (actor_person_id) REFERENCES public.person(id);


--
-- Name: decision decision_carried_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_carried_from_fkey FOREIGN KEY (carried_from) REFERENCES public.decision(id);


--
-- Name: decision_communication decision_communication_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decision(id);


--
-- Name: decision_communication decision_communication_recipient_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_recipient_org_id_fkey FOREIGN KEY (recipient_org_id) REFERENCES public.organization(id);


--
-- Name: decision_communication decision_communication_recipient_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_recipient_person_id_fkey FOREIGN KEY (recipient_person_id) REFERENCES public.person(id);


--
-- Name: decision_communication decision_communication_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.person(id);


--
-- Name: decision_communication decision_communication_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_communication
    ADD CONSTRAINT decision_communication_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: decision decision_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: decision decision_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.task_assignment(id);


--
-- Name: decision decision_via_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision
    ADD CONSTRAINT decision_via_delegation_id_fkey FOREIGN KEY (via_delegation_id) REFERENCES public.delegation(id);


--
-- Name: delegation delegation_delegate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation
    ADD CONSTRAINT delegation_delegate_id_fkey FOREIGN KEY (delegate_id) REFERENCES public.person(id);


--
-- Name: delegation delegation_delegator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation
    ADD CONSTRAINT delegation_delegator_id_fkey FOREIGN KEY (delegator_id) REFERENCES public.person(id);


--
-- Name: delegation delegation_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation
    ADD CONSTRAINT delegation_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.membership(id);


--
-- Name: delegation delegation_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation
    ADD CONSTRAINT delegation_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.person(id);


--
-- Name: deployment_area deployment_area_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_area
    ADD CONSTRAINT deployment_area_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.restationing_request(id);


--
-- Name: deployment_area deployment_area_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_area
    ADD CONSTRAINT deployment_area_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: execution_task execution_task_assigned_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_assigned_person_id_fkey FOREIGN KEY (assigned_person_id) REFERENCES public.person(id);


--
-- Name: execution_task execution_task_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.person(id);


--
-- Name: execution_task execution_task_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: execution_task execution_task_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.role_def(code);


--
-- Name: execution_task execution_task_target_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_task
    ADD CONSTRAINT execution_task_target_org_id_fkey FOREIGN KEY (target_org_id) REFERENCES public.organization(id);


--
-- Name: export_job export_job_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_job
    ADD CONSTRAINT export_job_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.person(id);


--
-- Name: flw_ru_batch_part flw_fk_batch_part_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_ru_batch_part
    ADD CONSTRAINT flw_fk_batch_part_parent FOREIGN KEY (batch_id_) REFERENCES public.flw_ru_batch(id_);


--
-- Name: flw_event_resource flw_fk_event_rsrc_dpl; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flw_event_resource
    ADD CONSTRAINT flw_fk_event_rsrc_dpl FOREIGN KEY (deployment_id_) REFERENCES public.flw_event_deployment(id_);


--
-- Name: form_definition form_definition_request_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_definition
    ADD CONSTRAINT form_definition_request_type_code_fkey FOREIGN KEY (request_type_code) REFERENCES public.request_type(code);


--
-- Name: form_version form_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: form_version form_version_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.form_definition(id);


--
-- Name: form_version form_version_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.person(id);


--
-- Name: hr_mapping_version hr_mapping_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_mapping_version
    ADD CONSTRAINT hr_mapping_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: hr_mapping_version hr_mapping_version_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_mapping_version
    ADD CONSTRAINT hr_mapping_version_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.person(id);


--
-- Name: hr_mapping_version hr_mapping_version_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_mapping_version
    ADD CONSTRAINT hr_mapping_version_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.hr_source(id);


--
-- Name: hr_person hr_person_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_person
    ADD CONSTRAINT hr_person_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.hr_snapshot(id) ON DELETE CASCADE;


--
-- Name: hr_snapshot hr_snapshot_mapping_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_snapshot
    ADD CONSTRAINT hr_snapshot_mapping_version_id_fkey FOREIGN KEY (mapping_version_id) REFERENCES public.hr_mapping_version(id);


--
-- Name: hr_snapshot hr_snapshot_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_snapshot
    ADD CONSTRAINT hr_snapshot_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.hr_sync_run(id);


--
-- Name: hr_sync_issue hr_sync_issue_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_issue
    ADD CONSTRAINT hr_sync_issue_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.hr_sync_run(id);


--
-- Name: hr_sync_run hr_sync_run_mapping_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_run
    ADD CONSTRAINT hr_sync_run_mapping_version_id_fkey FOREIGN KEY (mapping_version_id) REFERENCES public.hr_mapping_version(id);


--
-- Name: hr_sync_run hr_sync_run_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_run
    ADD CONSTRAINT hr_sync_run_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.person(id);


--
-- Name: hr_sync_run hr_sync_run_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_sync_run
    ADD CONSTRAINT hr_sync_run_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.hr_source(id);


--
-- Name: hr_unit hr_unit_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_unit
    ADD CONSTRAINT hr_unit_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.hr_snapshot(id) ON DELETE CASCADE;


--
-- Name: idempotency_record idempotency_record_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_record
    ADD CONSTRAINT idempotency_record_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: identity_link_issue identity_link_issue_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link_issue
    ADD CONSTRAINT identity_link_issue_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.person(id);


--
-- Name: identity_link_issue identity_link_issue_resolved_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link_issue
    ADD CONSTRAINT identity_link_issue_resolved_person_id_fkey FOREIGN KEY (resolved_person_id) REFERENCES public.person(id);


--
-- Name: identity_link identity_link_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link
    ADD CONSTRAINT identity_link_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.person(id);


--
-- Name: identity_link identity_link_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_link
    ADD CONSTRAINT identity_link_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: integration_run integration_run_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_run
    ADD CONSTRAINT integration_run_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.person(id);


--
-- Name: local_metadata local_metadata_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_metadata
    ADD CONSTRAINT local_metadata_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.person(id);


--
-- Name: map_import_job map_import_job_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_import_job
    ADD CONSTRAINT map_import_job_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: map_import_job map_import_job_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_import_job
    ADD CONSTRAINT map_import_job_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.person(id);


--
-- Name: map_import_job map_import_job_target_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_import_job
    ADD CONSTRAINT map_import_job_target_site_id_fkey FOREIGN KEY (target_site_id) REFERENCES public.site(id);


--
-- Name: map_package map_package_status_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_package
    ADD CONSTRAINT map_package_status_changed_by_fkey FOREIGN KEY (status_changed_by) REFERENCES public.person(id);


--
-- Name: map_package map_package_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_package
    ADD CONSTRAINT map_package_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.person(id);


--
-- Name: membership membership_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.person(id);


--
-- Name: membership membership_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: membership membership_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: membership membership_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.role_def(code);


--
-- Name: membership_scope_target membership_scope_target_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_scope_target
    ADD CONSTRAINT membership_scope_target_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.membership(id);


--
-- Name: membership membership_site_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_site_scope_id_fkey FOREIGN KEY (site_scope_id) REFERENCES public.site(id);


--
-- Name: notification notification_outbox_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_outbox_event_id_fkey FOREIGN KEY (outbox_event_id) REFERENCES public.outbox_event(id);


--
-- Name: notification notification_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: notification notification_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: org_stationing org_stationing_base_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_base_id_fkey FOREIGN KEY (base_id) REFERENCES public.org_stationing(id);


--
-- Name: org_stationing org_stationing_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.person(id);


--
-- Name: org_stationing org_stationing_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: org_stationing org_stationing_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.person(id);


--
-- Name: org_stationing org_stationing_request_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_request_fk FOREIGN KEY (request_id) REFERENCES public.restationing_request(id);


--
-- Name: org_stationing org_stationing_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_stationing
    ADD CONSTRAINT org_stationing_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: org_unit_symbol org_unit_symbol_catalog_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_unit_symbol
    ADD CONSTRAINT org_unit_symbol_catalog_code_fkey FOREIGN KEY (catalog_code) REFERENCES public.unit_symbol_catalog(code);


--
-- Name: org_unit_symbol org_unit_symbol_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_unit_symbol
    ADD CONSTRAINT org_unit_symbol_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: org_unit_symbol org_unit_symbol_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_unit_symbol
    ADD CONSTRAINT org_unit_symbol_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.person(id);


--
-- Name: organization organization_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.organization(id);


--
-- Name: placement_rule placement_rule_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_rule
    ADD CONSTRAINT placement_rule_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: placement_rule placement_rule_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_rule
    ADD CONSTRAINT placement_rule_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.person(id);


--
-- Name: policy_version policy_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_version
    ADD CONSTRAINT policy_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: policy_version policy_version_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_version
    ADD CONSTRAINT policy_version_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.person(id);


--
-- Name: position_seat position_seat_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: position_seat position_seat_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: position_seat position_seat_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.role_def(code);


--
-- Name: position_seat position_seat_site_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_seat
    ADD CONSTRAINT position_seat_site_scope_id_fkey FOREIGN KEY (site_scope_id) REFERENCES public.site(id);


--
-- Name: request request_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.person(id);


--
-- Name: request request_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: request request_form_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_form_version_id_fkey FOREIGN KEY (form_version_id) REFERENCES public.form_version(id);


--
-- Name: request request_owner_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_owner_org_id_fkey FOREIGN KEY (owner_org_id) REFERENCES public.organization(id);


--
-- Name: request_participant request_participant_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_participant
    ADD CONSTRAINT request_participant_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: request_participant request_participant_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_participant
    ADD CONSTRAINT request_participant_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: request request_policy_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_policy_version_id_fkey FOREIGN KEY (policy_version_id) REFERENCES public.policy_version(id);


--
-- Name: request_relocation request_relocation_from_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_from_site_id_fkey FOREIGN KEY (from_site_id) REFERENCES public.site(id);


--
-- Name: request_relocation request_relocation_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: request_relocation request_relocation_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: request_relocation request_relocation_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.placement_rule(id);


--
-- Name: request_relocation request_relocation_target_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_target_site_id_fkey FOREIGN KEY (target_site_id) REFERENCES public.site(id);


--
-- Name: request_relocation request_relocation_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_relocation
    ADD CONSTRAINT request_relocation_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.person(id);


--
-- Name: request_resource request_resource_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_resource
    ADD CONSTRAINT request_resource_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: request_resource request_resource_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_resource
    ADD CONSTRAINT request_resource_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resource(id);


--
-- Name: request_revision request_revision_form_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_form_version_id_fkey FOREIGN KEY (form_version_id) REFERENCES public.form_version(id);


--
-- Name: request_revision request_revision_policy_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_policy_version_id_fkey FOREIGN KEY (policy_version_id) REFERENCES public.policy_version(id);


--
-- Name: request_revision request_revision_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: request_revision request_revision_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.person(id);


--
-- Name: request_revision request_revision_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_revision
    ADD CONSTRAINT request_revision_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_version(id);


--
-- Name: request request_target_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_target_reservation_id_fkey FOREIGN KEY (target_reservation_id) REFERENCES public.reservation(id);


--
-- Name: request request_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_type_code_fkey FOREIGN KEY (type_code) REFERENCES public.request_type(code);


--
-- Name: request request_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request
    ADD CONSTRAINT request_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_version(id);


--
-- Name: reservation_change reservation_change_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_change
    ADD CONSTRAINT reservation_change_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: reservation_change reservation_change_request_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_change
    ADD CONSTRAINT reservation_change_request_fk FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: reservation_change reservation_change_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_change
    ADD CONSTRAINT reservation_change_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservation(id);


--
-- Name: reservation_lock reservation_lock_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock
    ADD CONSTRAINT reservation_lock_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservation(id);


--
-- Name: reservation_lock reservation_lock_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_lock
    ADD CONSTRAINT reservation_lock_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resource(id);


--
-- Name: reservation reservation_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation
    ADD CONSTRAINT reservation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: reservation reservation_request_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation
    ADD CONSTRAINT reservation_request_fk FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: reservation reservation_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation
    ADD CONSTRAINT reservation_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resource(id);


--
-- Name: resource resource_parent_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource
    ADD CONSTRAINT resource_parent_resource_id_fkey FOREIGN KEY (parent_resource_id) REFERENCES public.resource(id);


--
-- Name: resource resource_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource
    ADD CONSTRAINT resource_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: restationing_action restationing_action_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_action
    ADD CONSTRAINT restationing_action_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.person(id);


--
-- Name: restationing_action restationing_action_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_action
    ADD CONSTRAINT restationing_action_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.restationing_request(id);


--
-- Name: restationing_action restationing_action_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_action
    ADD CONSTRAINT restationing_action_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.person(id);


--
-- Name: restationing_request restationing_request_activated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES public.person(id);


--
-- Name: restationing_request restationing_request_final_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_final_approver_id_fkey FOREIGN KEY (final_approver_id) REFERENCES public.person(id);


--
-- Name: restationing_request restationing_request_parent_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_parent_request_id_fkey FOREIGN KEY (parent_request_id) REFERENCES public.restationing_request(id);


--
-- Name: restationing_request restationing_request_policy_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_policy_version_fkey FOREIGN KEY (policy_version) REFERENCES public.stationing_policy_version(version);


--
-- Name: restationing_request restationing_request_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.person(id);


--
-- Name: restationing_request restationing_request_requesting_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_requesting_unit_id_fkey FOREIGN KEY (requesting_unit_id) REFERENCES public.organization(id);


--
-- Name: restationing_request restationing_request_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_request
    ADD CONSTRAINT restationing_request_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: restationing_revision restationing_revision_policy_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_revision
    ADD CONSTRAINT restationing_revision_policy_version_fkey FOREIGN KEY (policy_version) REFERENCES public.stationing_policy_version(version);


--
-- Name: restationing_revision restationing_revision_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_revision
    ADD CONSTRAINT restationing_revision_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.restationing_request(id);


--
-- Name: restationing_revision restationing_revision_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_revision
    ADD CONSTRAINT restationing_revision_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.person(id);


--
-- Name: restationing_stage restationing_stage_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.person(id);


--
-- Name: restationing_stage restationing_stage_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.restationing_request(id);


--
-- Name: restationing_stage restationing_stage_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.organization(id);


--
-- Name: restationing_stage restationing_stage_via_delegation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restationing_stage
    ADD CONSTRAINT restationing_stage_via_delegation_fkey FOREIGN KEY (via_delegation) REFERENCES public.delegation(id);


--
-- Name: signature_evidence signature_evidence_signing_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_evidence
    ADD CONSTRAINT signature_evidence_signing_job_id_fkey FOREIGN KEY (signing_job_id) REFERENCES public.signing_job(id);


--
-- Name: signing_job signing_job_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decision(id);


--
-- Name: signing_job signing_job_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: signing_job signing_job_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: signing_job signing_job_signer_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_signer_person_id_fkey FOREIGN KEY (signer_person_id) REFERENCES public.person(id);


--
-- Name: signing_job signing_job_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_job
    ADD CONSTRAINT signing_job_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.task_assignment(id);


--
-- Name: site_geometry_version site_geometry_import_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_geometry_version
    ADD CONSTRAINT site_geometry_import_fk FOREIGN KEY (import_job_id) REFERENCES public.map_import_job(id);


--
-- Name: site_geometry_version site_geometry_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_geometry_version
    ADD CONSTRAINT site_geometry_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: site site_geometry_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_geometry_version_fk FOREIGN KEY (id, geometry_version) REFERENCES public.site_geometry_version(site_id, version) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: site_geometry_version site_geometry_version_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_geometry_version
    ADD CONSTRAINT site_geometry_version_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: site_link site_link_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_link
    ADD CONSTRAINT site_link_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: site_link site_link_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_link
    ADD CONSTRAINT site_link_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.person(id);


--
-- Name: site_link site_link_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_link
    ADD CONSTRAINT site_link_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: site_link site_link_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_link
    ADD CONSTRAINT site_link_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: site site_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.site(id);


--
-- Name: site_responsibility site_responsibility_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_responsibility
    ADD CONSTRAINT site_responsibility_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: site_responsibility site_responsibility_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_responsibility
    ADD CONSTRAINT site_responsibility_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id);


--
-- Name: stationing_outbox stationing_outbox_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_outbox
    ADD CONSTRAINT stationing_outbox_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: stationing_policy_version stationing_policy_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_policy_version
    ADD CONSTRAINT stationing_policy_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: stationing_policy_version stationing_policy_version_previous_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stationing_policy_version
    ADD CONSTRAINT stationing_policy_version_previous_id_fkey FOREIGN KEY (previous_id) REFERENCES public.stationing_policy_version(id);


--
-- Name: task_assignment task_assignment_assigned_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_assigned_person_id_fkey FOREIGN KEY (assigned_person_id) REFERENCES public.person(id);


--
-- Name: task_assignment task_assignment_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: task_assignment task_assignment_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.role_def(code);


--
-- Name: task_assignment task_assignment_target_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignment
    ADD CONSTRAINT task_assignment_target_org_id_fkey FOREIGN KEY (target_org_id) REFERENCES public.organization(id);


--
-- Name: task_reassignment task_reassignment_assigned_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_reassignment
    ADD CONSTRAINT task_reassignment_assigned_person_id_fkey FOREIGN KEY (assigned_person_id) REFERENCES public.person(id);


--
-- Name: task_reassignment task_reassignment_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_reassignment
    ADD CONSTRAINT task_reassignment_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.request(id);


--
-- Name: task_reassignment task_reassignment_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_reassignment
    ADD CONSTRAINT task_reassignment_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.person(id);


--
-- Name: task_reassignment task_reassignment_routed_to_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_reassignment
    ADD CONSTRAINT task_reassignment_routed_to_org_fkey FOREIGN KEY (routed_to_org) REFERENCES public.organization(id);


--
-- Name: terrain_slope terrain_slope_dataset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terrain_slope
    ADD CONSTRAINT terrain_slope_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.terrain_dataset(id);


--
-- Name: unit_symbol_catalog unit_symbol_catalog_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_symbol_catalog
    ADD CONSTRAINT unit_symbol_catalog_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: user_session user_session_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_session
    ADD CONSTRAINT user_session_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(id);


--
-- Name: validation_report validation_report_signing_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_report
    ADD CONSTRAINT validation_report_signing_job_id_fkey FOREIGN KEY (signing_job_id) REFERENCES public.signing_job(id);


--
-- Name: validation_report validation_report_validated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_report
    ADD CONSTRAINT validation_report_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.person(id);


--
-- Name: workflow_definition workflow_definition_request_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definition
    ADD CONSTRAINT workflow_definition_request_type_code_fkey FOREIGN KEY (request_type_code) REFERENCES public.request_type(code);


--
-- Name: workflow_version workflow_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_version
    ADD CONSTRAINT workflow_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.person(id);


--
-- Name: workflow_version workflow_version_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_version
    ADD CONSTRAINT workflow_version_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.person(id);


--
-- Name: workflow_version workflow_version_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_version
    ADD CONSTRAINT workflow_version_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflow_definition(id);


--
-- PostgreSQL database dump complete
--

\unrestrict 5UhU6R7yyibO3Dm9uztKTeSQa6Rx39OsILlTdohiBEJ9ZGouT81uosIiLcjelRl

