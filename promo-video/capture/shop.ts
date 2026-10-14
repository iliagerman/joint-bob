// The staging shop the browser film's agent visits: three pages on a loopback port, with one
// bug. A promo code fails at checkout until the agent's fix is "deployed" (POST /__fix).
// Invented, like everything else in the film. The type is large because the page is seen
// inside the app's browser panel, then again inside the film.
import { createServer, type Server } from "node:http";

const products = [
  { id: "mug", name: "Enamel mug", price: 18, picture: "☕" },
  { id: "tote", name: "Canvas tote", price: 24, picture: "👜" },
  { id: "notebook", name: "Field notebook", price: 12, picture: "📓" },
];

const style = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 26px/1.4 -apple-system, "Segoe UI", sans-serif; color: #1c1917; background: #faf7f2; }
  header { display: flex; align-items: center; gap: 20px; padding: 28px 64px; background: #fff; border-bottom: 2px solid #ece7df; }
  header b { font-size: 40px; letter-spacing: -0.02em; }
  header span { font-size: 20px; font-weight: 700; padding: 4px 14px; border-radius: 999px; background: #fde68a; color: #713f12; }
  header a, button { margin-left: auto; font: inherit; font-weight: 700; padding: 16px 30px; border: 0; border-radius: 16px; background: #1c1917; color: #fff; text-decoration: none; cursor: pointer; }
  main { padding: 48px 64px; }
  h1 { font-size: 54px; margin: 0 0 32px; letter-spacing: -0.02em; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
  .card { background: #fff; border: 2px solid #ece7df; border-radius: 28px; padding: 32px; display: flex; flex-direction: column; gap: 14px; }
  .card i { font-style: normal; font-size: 150px; line-height: 1.1; text-align: center; background: #f5efe6; border-radius: 20px; padding: 20px 0; }
  .card b { font-size: 34px; }
  .card button { margin: 8px 0 0; }
  .card button.added { background: #15803d; }
  .box { background: #fff; border: 2px solid #ece7df; border-radius: 28px; padding: 40px; max-width: 980px; display: flex; flex-direction: column; gap: 26px; }
  .line { display: flex; justify-content: space-between; font-size: 32px; }
  .promo { display: flex; gap: 16px; }
  .promo input { flex: 1; font: inherit; padding: 16px 22px; border: 2px solid #d6cfc4; border-radius: 16px; }
  .promo button { margin: 0; background: #57534e; }
  #error { display: none; padding: 22px 26px; border-radius: 16px; background: #fee2e2; color: #991b1b; font-weight: 700; border: 2px solid #fca5a5; }
  #discount { display: none; color: #15803d; font-weight: 700; }
  #total { font-size: 44px; font-weight: 800; }
  #place { margin: 0; font-size: 32px; padding: 22px; background: #2563eb; }
  .done { text-align: center; padding-top: 120px; }
  .done h1 { font-size: 84px; }
`;

const page = (body: string, cart: string[]): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind Shop (staging)</title><style>${style}</style></head><body>
<header><b>Northwind Shop</b><span>staging</span><a id="checkout" href="/checkout">Checkout (<em id="count" style="font-style:normal">${cart.length}</em>)</a></header><main>${body}</main></body></html>`;

export function startShop(port: number): Promise<Server> {
  let cart: string[] = [];
  let fixed = false;
  const total = (): number => cart.reduce((sum, id) => sum + products.find((product) => product.id === id)!.price, 0);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status: number, type: string, body: string): void => { response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); response.end(body); };
    if (request.method === "POST" && url === "/__fix") { fixed = true; send(200, "application/json", "{}"); return; }
    if (request.method === "POST" && url.startsWith("/cart/")) { cart.push(url.slice(6)); send(200, "application/json", JSON.stringify({ count: cart.length })); return; }
    if (request.method === "POST" && url === "/promo") {
      // The bug: the handler reads a field the stored code does not have.
      if (!fixed) { send(500, "application/json", JSON.stringify({ error: "TypeError: promo.percent is undefined" })); return; }
      send(200, "application/json", JSON.stringify({ off: total() * 0.1, total: total() * 0.9 }));
      return;
    }
    if (url === "/") {
      send(200, "text/html", page(`<h1>New this week</h1><div class="grid">${products.map((product) => `<div class="card"><i>${product.picture}</i><b>${product.name}</b><span>$${product.price}.00</span><button id="add-${product.id}" onclick="fetch('/cart/${product.id}',{method:'POST'}).then(r=>r.json()).then(d=>{count.textContent=d.count;this.textContent='Added ✓';this.className='added'})">Add to cart</button></div>`).join("")}</div>`, cart));
      return;
    }
    if (url === "/checkout") {
      send(200, "text/html", page(`<h1>Checkout</h1><div class="box">
        ${cart.map((id) => { const product = products.find((candidate) => candidate.id === id)!; return `<div class="line"><span>${product.picture} ${product.name}</span><span>$${product.price}.00</span></div>`; }).join("")}
        <div class="promo"><input id="promo" name="code" placeholder="Promo code" autocomplete="off"><button id="apply" onclick="fetch('/promo',{method:'POST'}).then(async r=>{const d=await r.json();if(!r.ok){error.style.display='block';total.textContent='—';return}error.style.display='none';discount.style.display='flex';off.textContent='−$'+d.off.toFixed(2);total.textContent='$'+d.total.toFixed(2)})">Apply</button></div>
        <div id="error">Something went wrong. Please try again. (500)</div>
        <div class="line" id="discount"><span>WELCOME10 · 10% off</span><span id="off"></span></div>
        <div class="line"><span>Total</span><span id="total">$${total().toFixed(2)}</span></div>
        <button id="place" onclick="location.href='/done'">Place order</button></div>`, cart));
      return;
    }
    if (url === "/done") { cart = []; send(200, "text/html", page(`<div class="done"><h1>Order confirmed 🎉</h1><p>Order #1042 is on its way.</p></div>`, cart)); return; }
    send(404, "text/plain", "Not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
