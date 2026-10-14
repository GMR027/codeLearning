const lista = document.querySelector("#lista");
const formulario = document.querySelector("#formulario");

async function cargar() {
  const respuesta = await fetch("/api/productos");
  const productos = await respuesta.json();
  lista.innerHTML = "";
  for (const p of productos) {
    const li = document.createElement("li");
    li.textContent = `${p.nombre} — $${p.precio.toFixed(2)}`;
    lista.append(li);
  }
}

formulario.addEventListener("submit", async (e) => {
  e.preventDefault();
  const datos = new FormData(formulario);
  await fetch("/api/productos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre: datos.get("nombre"), precio: Number(datos.get("precio")) }),
  });
  formulario.reset();
  cargar();
});

cargar();
