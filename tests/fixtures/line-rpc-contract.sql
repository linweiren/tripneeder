-- Test fixture only; exact definitions from verified 2026-11-04 backup. Never apply as a migration.
CREATE FUNCTION public.bind_line_user(p_user_id uuid, p_line_user_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_existing_user_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '使用者 ID 不得為空';
  END IF;

  IF p_line_user_id IS NULL
     OR pg_catalog.btrim(p_line_user_id) = '' THEN
    RAISE EXCEPTION 'LINE ID 不得為空白';
  END IF;

  -- 確認會員存在，並鎖定該會員資料直到交易結束
  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到會員資料，請先完成會員初始化';
  END IF;

  -- 禁止將其他會員已綁定的 LINE 帳號移到目前會員
  SELECT id
  INTO v_existing_user_id
  FROM public.profiles
  WHERE line_user_id = p_line_user_id;

  IF v_existing_user_id IS NOT NULL
     AND v_existing_user_id <> p_user_id THEN
    RAISE EXCEPTION
      '此 LINE 帳號已被其他會員綁定，請先至原帳號解除綁定。';
  END IF;

  UPDATE public.profiles
  SET line_user_id = p_line_user_id,
      updated_at = pg_catalog.now()
  WHERE id = p_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'line_user_id', p_line_user_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.bind_line_user(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_line_user(uuid,text) TO service_role;
CREATE FUNCTION public.unbind_line_user(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '使用者 ID 不得為空';
  END IF;

  UPDATE public.profiles
  SET line_user_id = NULL,
      updated_at = pg_catalog.now()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到會員資料，請先完成會員初始化';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true
  );
END;
$$;
REVOKE ALL ON FUNCTION public.unbind_line_user(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.unbind_line_user(uuid) TO service_role;
CREATE FUNCTION public.get_line_user_profile(p_line_user_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_profile RECORD;
BEGIN
  IF p_line_user_id IS NULL
     OR pg_catalog.btrim(p_line_user_id) = '' THEN
    RAISE EXCEPTION 'LINE ID 不得為空白';
  END IF;

  SELECT id, email, display_name, points_balance
  INTO v_profile
  FROM public.profiles
  WHERE line_user_id = p_line_user_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_profile.id,
    'email', v_profile.email,
    'display_name', v_profile.display_name,
    'points_balance', v_profile.points_balance
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_line_user_profile(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_line_user_profile(text) TO service_role;
CREATE FUNCTION public.consume_points_for_line_user(p_line_user_id text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_profile RECORD;
  v_cost CONSTANT INT := 20;
  v_new_balance INT;
BEGIN
  IF p_line_user_id IS NULL
     OR pg_catalog.btrim(p_line_user_id) = '' THEN
    RAISE EXCEPTION 'LINE ID 不得為空白';
  END IF;

  -- 鎖定會員資料，避免同時扣點造成餘額計算錯誤
  SELECT id, points_balance
  INTO v_profile
  FROM public.profiles
  WHERE line_user_id = p_line_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到已綁定的會員帳號';
  END IF;

  IF v_profile.points_balance IS NULL THEN
    RAISE EXCEPTION '會員點數資料異常';
  END IF;

  IF v_profile.points_balance < v_cost THEN
    RAISE EXCEPTION '點數不足';
  END IF;

  v_new_balance := v_profile.points_balance - v_cost;

  UPDATE public.profiles
  SET points_balance = v_new_balance,
      updated_at = pg_catalog.now()
  WHERE id = v_profile.id;

  INSERT INTO public.point_transactions (
    user_id,
    type,
    amount,
    balance_after,
    reason,
    created_by
  )
  VALUES (
    v_profile.id,
    'consume',
    -v_cost,
    v_new_balance,
    p_reason,
    NULL
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'balance', v_new_balance
  );
END;
$$;
REVOKE ALL ON FUNCTION public.consume_points_for_line_user(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_points_for_line_user(text,text) TO service_role;
