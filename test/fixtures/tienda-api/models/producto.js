const db = require("../config/db");

// Acceso a la tabla productos.
const Producto = {
  todos() {
    return db.prepare("SELECT * FROM productos ORDER BY id").all();
  },

  buscar(id) {
    return db.prepare("SELECT * FROM productos WHERE id = ?").get(id);
  },

  crear({ nombre, precio, stock = 0 }) {
    const r = db.prepare("INSERT INTO productos (nombre, precio, stock) VALUES (?, ?, ?)").run(nombre, precio, stock);
    return Producto.buscar(Number(r.lastInsertRowid));
  },

  borrar(id) {
    return db.prepare("DELETE FROM productos WHERE id = ?").run(id).changes > 0;
  },
};

module.exports = Producto;
