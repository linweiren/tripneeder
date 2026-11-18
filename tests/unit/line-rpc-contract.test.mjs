import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
// Git normalizes SQL text to LF; hash that canonical text on every platform.
const fixture=readFileSync(new URL('../fixtures/line-rpc-contract.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const contract=JSON.parse(readFileSync(new URL('../../docs/security/line-rpc-contract-20261104.json',import.meta.url),'utf8'))
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222'
const line='U'+'a'.repeat(32)
async function database() {
  const db=new PGlite()
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),email text,display_name text,points_balance integer,updated_at timestamptz,line_user_id text UNIQUE);
    CREATE TABLE public.point_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,amount integer,balance_after integer,reason text,created_by uuid);
    INSERT INTO auth.users VALUES('${A}'),('${B}');
    INSERT INTO public.profiles(id,points_balance) VALUES('${A}',40),('${B}',100);`)
  await db.exec(fixture)
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261027220000_paid_generation_consistency_v1.sql',import.meta.url),'utf8'))
  return db
}
test('LINE fixture fingerprint matches exact exported contract and role privileges',async()=>{
  assert.equal(createHash('sha256').update(fixture).digest('hex'),contract.fixtureSha256)
  const db=await database()
  try {
    for(const {signature} of contract.lineChecks)for(const role of ['anon','authenticated','service_role']){
      const r=await db.query(`select has_function_privilege($1,$2,'EXECUTE') as allowed`,[role,`public.${signature}`])
      assert.equal(r.rows[0].allowed,role==='service_role',`${signature} ${role}`)
    }
  }finally{await db.close()}
})
test('existing bind enforces uniqueness, repeat binding is idempotent, unlink leaves points and users intact',async()=>{
  const db=await database()
  try{
    await db.query('select bind_line_user($1,$2)',[A,line])
    await db.query('select bind_line_user($1,$2)',[A,line])
    await assert.rejects(db.query('select bind_line_user($1,$2)',[B,line]))
    assert.deepEqual((await db.query('select id,line_user_id,points_balance from profiles order by id')).rows,[{id:A,line_user_id:line,points_balance:40},{id:B,line_user_id:null,points_balance:100}])
    await db.query('select unbind_line_user($1)',[A])
    await db.query('select bind_line_user($1,$2)',[B,line])
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n,2)
    assert.equal((await db.query('select count(*)::int as n from point_transactions')).rows[0].n,0)
  }finally{await db.close()}
})
test('legacy LINE consume is already atomic: failed ledger insert rolls balance back and insufficient points rejects',async()=>{
  const db=await database()
  try{
    await db.query('select bind_line_user($1,$2)',[A,line])
    await db.exec(`create function public.fail_test_ledger() returns trigger language plpgsql as $$begin raise exception 'synthetic ledger failure'; end;$$;
      create trigger fail_test before insert on point_transactions for each row execute function public.fail_test_ledger();`)
    await assert.rejects(db.query('select consume_points_for_line_user($1,$2)',[line,'test']))
    assert.equal((await db.query('select points_balance from profiles where id=$1',[A])).rows[0].points_balance,40)
    await db.exec('drop trigger fail_test on point_transactions')
    await db.query('select consume_points_for_line_user($1,$2)',[line,'test'])
    await db.query('select consume_points_for_line_user($1,$2)',[line,'test'])
    await assert.rejects(db.query('select consume_points_for_line_user($1,$2)',[line,'test']))
    assert.equal((await db.query('select points_balance from profiles where id=$1',[A])).rows[0].points_balance,0)
    assert.equal((await db.query('select sum(amount)::int as n from point_transactions')).rows[0].n,-40)
  }finally{await db.close()}
})
test('shared payment transaction rolls snapshot and balance back on ledger failure; replay charges once',async()=>{
  const db=await database()
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  try{
    const claim=(await db.query('select claim_trip_generation($1,$2,$3) as c',[A,id,{location:{name:'fixture'}}])).rows[0].c
    const token=claim.attemptToken,response={plans:[{id:'safe'}]}
    await db.exec(`create function public.fail_test_ledger() returns trigger language plpgsql as $$begin raise exception 'synthetic ledger failure'; end;$$;
      create trigger fail_test before insert on point_transactions for each row execute function public.fail_test_ledger();`)
    await assert.rejects(db.query('select complete_paid_trip_generation($1,$2,$3,$4)',[A,id,token,response]))
    assert.equal((await db.query('select points_balance from profiles where id=$1',[A])).rows[0].points_balance,40)
    assert.equal((await db.query('select status from trip_generations')).rows[0].status,'running')
    await db.exec('drop trigger fail_test on point_transactions')
    await db.query('select complete_paid_trip_generation($1,$2,$3,$4)',[A,id,token,response])
    await db.query('select complete_paid_trip_generation($1,$2,$3,$4)',[A,id,token,response])
    assert.equal((await db.query('select points_balance from profiles where id=$1',[A])).rows[0].points_balance,20)
    assert.deepEqual((await db.query('select count(*)::int as n,sum(amount)::int as sum from point_transactions')).rows[0],{n:1,sum:-20})
    assert.equal((await db.query('select claim_trip_generation($1,$2,$3) as c',[B,id,{location:{name:'fixture'}}])).rows[0].c.outcome,'missing')
  }finally{await db.close()}
})
