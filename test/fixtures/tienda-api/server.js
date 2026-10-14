const express = require("express");
const productos = require("./routes/productos");

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/api/productos", productos);

const port = process.env.PORT || 3000;

// Solo se escucha si se ejecuta directamente (los tests importan la app).
if (require.main === module) {
  app.listen(port, () => console.log(`Tienda en http://localhost:${port}`));
}

module.exports = app;
