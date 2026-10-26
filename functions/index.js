// CasaBalance — Cloud Functions
// extraerResumen: recibe el PDF de un resumen de tarjeta y devuelve sus líneas clasificadas usando Claude.
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const Anthropic = require("@anthropic-ai/sdk").default;
const {betaZodOutputFormat} = require("@anthropic-ai/sdk/helpers/beta/zod");
const {z} = require("zod");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const TIPOS = ["consumo", "cuota", "fijo", "impuesto", "interes", "pago", "otro"];

const ResumenSchema = z.object({
  tarjeta_detectada: z.string(),
  fecha_cierre: z.string(),
  fecha_vencimiento: z.string(),
  total_ars: z.number(),
  total_usd: z.number(),
  items: z.array(z.object({
    fecha: z.string(),
    desc: z.string(),
    monto: z.number(),
    moneda: z.enum(["ARS", "USD"]),
    tipo: z.enum(TIPOS),
    cuota_numero: z.number().int().nullable(),
    cuotas_total: z.number().int().nullable(),
    rubro: z.string(),
    titular: z.string().nullable(),
  })),
  notas: z.string(),
});

function buildPrompt(tarjeta, rubros) {
  return `Este PDF es el resumen de la tarjeta de crédito "${tarjeta}" de una familia argentina.
Extraé TODAS las líneas que generan el total a pagar y devolvelas en el formato pedido.

Reglas:
- fecha_cierre y fecha_vencimiento en formato AAAA-MM-DD. fecha de cada línea también en AAAA-MM-DD (si el resumen no trae año, deducilo del período).
- total_ars y total_usd: el "saldo actual" / "total a pagar" del resumen en cada moneda (0 si no hay).
- monto: positivo para cargos, negativo para créditos, bonificaciones o devoluciones.
- tipo:
  - "cuota": compra en cuotas (ej. "C.04/12", "Cuota 4 de 12"). Completá cuota_numero y cuotas_total.
  - "fijo": débitos automáticos y cargos recurrentes (seguros, cuotas sociales, suscripciones, colegios/facultades, servicios).
  - "consumo": compra en un pago.
  - "impuesto": IVA, percepciones, impuesto de sellos, Ley 25.413, etc.
  - "interes": intereses de financiación o punitorios, comisiones, cargos por mantenimiento o renovación.
  - "pago": pagos recibidos y el saldo del resumen anterior. No forman parte del gasto del mes.
  - "otro": lo que no entre en las anteriores.
- cuota_numero y cuotas_total en null si no es una cuota.
- rubro: elegí el más adecuado de esta lista: ${rubros.join(", ")}. Si ninguno encaja, usá "Otros".
- titular: si el resumen separa consumos por titular o adicional, poné el nombre; si no, null.
- desc: el nombre del comercio o concepto tal como figura, sin códigos de autorización.
- No inventes líneas. Si algo no se puede leer, mencionalo en notas.`;
}

// Verifica el acceso con las mismas reglas de Firestore que ya usa la app:
// si el usuario puede leer casabalance/config con su token, puede usar la función.
async function verificarAcceso(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión para usar esta función.");
  const header = request.rawRequest.headers.authorization || "";
  const project = process.env.GCLOUD_PROJECT;
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/casabalance/config`;
  const res = await fetch(url, {headers: {Authorization: header}});
  if (!res.ok) throw new HttpsError("permission-denied", "Tu cuenta no tiene acceso a CasaBalance.");
}

exports.extraerResumen = onCall(
  {secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: "512MiB", region: "us-central1"},
  async (request) => {
    await verificarAcceso(request);

    const {pdf, tarjeta, rubros} = request.data || {};
    if (typeof pdf !== "string" || pdf.length < 100) {
      throw new HttpsError("invalid-argument", "Falta el PDF del resumen.");
    }
    const listaRubros = Array.isArray(rubros) && rubros.length ? rubros : ["Otros"];

    const client = new Anthropic({apiKey: ANTHROPIC_API_KEY.value()});
    let response;
    try {
      response = await client.beta.messages.parse({
        model: "claude-sonnet-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {effort: "medium", format: betaZodOutputFormat(ResumenSchema)},
        messages: [{
          role: "user",
          content: [
            {type: "document", source: {type: "base64", media_type: "application/pdf", data: pdf}},
            {type: "text", text: buildPrompt(tarjeta || "desconocida", listaRubros)},
          ],
        }],
      });
    } catch (error) {
      console.error("Claude API error:", error);
      if (error instanceof Anthropic.BadRequestError) {
        throw new HttpsError("invalid-argument", "No se pudo leer el PDF (¿está protegido con contraseña o dañado?).");
      } else if (error instanceof Anthropic.AuthenticationError) {
        throw new HttpsError("failed-precondition", "La API key de Anthropic no es válida.");
      } else if (error instanceof Anthropic.RateLimitError) {
        throw new HttpsError("resource-exhausted", "Demasiados pedidos seguidos. Probá en un minuto.");
      }
      throw new HttpsError("internal", "Error al procesar el resumen.");
    }

    if (response.stop_reason === "refusal") {
      throw new HttpsError("failed-precondition", "El modelo no pudo procesar este documento.");
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new HttpsError("internal", "El resumen es demasiado largo o no se pudo interpretar.");
    }
    console.log("extraerResumen ok", {tarjeta, items: response.parsed_output.items.length, usage: response.usage});
    return response.parsed_output;
  },
);
