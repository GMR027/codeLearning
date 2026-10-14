const test = require("node:test");
const assert = require("node:assert");
const app = require("../server");

test("crea y lista productos", async () => {
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}/api/productos`;
  const creado = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre: "Café", precio: 4.5 }),
  });
  assert.strictEqual(creado.status, 201);
  const lista = await (await fetch(base)).json();
  assert.strictEqual(lista.length, 1);
  server.close();
});
