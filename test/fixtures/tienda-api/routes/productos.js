const express = require("express");
const productos = require("../controllers/productosController");

const router = express.Router();

router.get("/", productos.listar);
router.get("/:id", productos.ver);
router.post("/", productos.crear);
router.delete("/:id", productos.borrar);

module.exports = router;
