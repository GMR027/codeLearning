const Producto = require("../models/producto");

function listar(req, res) {
  res.json(Producto.todos());
}

function ver(req, res) {
  const producto = Producto.buscar(Number(req.params.id));
  if (!producto) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(producto);
}

function crear(req, res) {
  const { nombre, precio, stock } = req.body ?? {};
  if (!nombre || typeof precio !== "number" || precio < 0) {
    return res.status(400).json({ error: "Nombre y precio válidos son obligatorios" });
  }
  res.status(201).json(Producto.crear({ nombre, precio, stock }));
}

function borrar(req, res) {
  if (!Producto.borrar(Number(req.params.id))) return res.status(404).json({ error: "Producto no encontrado" });
  res.status(204).end();
}

module.exports = { listar, ver, crear, borrar };
