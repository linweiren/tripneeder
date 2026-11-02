import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { runWeatherUpgradeCases } from '../fixtures/weather-upgrade-cases.mjs'

test('complete weather upgrade chain on PostgreSQL',async t=>{
  await runWeatherUpgradeCases((name,fn)=>t.test(name,fn),async()=>{
    const db=new PGlite()
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;')
    return {query:(sql,params)=>params ? db.query(sql,params) : db.exec(sql).then(results=>results.at(-1)),end:()=>db.close()}
  })
})
