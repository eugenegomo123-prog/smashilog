import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

// Cloudflare Workers have no persistent process, so there's no single module-scope
// `db` object like the Netlify version had (`drizzle-orm/netlify-db` relied on Netlify
// injecting a connection string into `process.env` for every invocation). Instead, each
// request handler pulls `DATABASE_URL` from its own `env` bindings and builds a client
// with it. This is cheap: the Neon HTTP driver doesn't hold a persistent connection --
// every query is a single fetch() call -- so there's no pooling cost to re-creating it.
//
// No `schema` option is passed here: this app only uses the plain query builder
// (db.select()/.insert()/.update()/.delete()), never the `db.query.*` relational API,
// which is the only thing that option is for.
export function getDb(databaseUrl: string) {
  return drizzle({ client: neon(databaseUrl) });
}

export type Db = ReturnType<typeof getDb>;
