const databasePath = process.env["DATABASE_PATH"] ??
  "./data/morning-post.sqlite";

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: databasePath,
  },
};
