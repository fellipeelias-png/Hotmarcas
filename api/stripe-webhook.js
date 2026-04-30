const Stripe = require('stripe');
const { Resend } = require('resend');

// Vercel disables body parsing for raw streams — needed for Stripe signature verification
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || 'não informado';
    const name = session.customer_details?.name || 'não informado';
    const tierName = session.metadata?.tierName || session.metadata?.tier || 'não informado';
    const amount = ((session.amount_total || 0) / 100).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL',
    });
    const date = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dashboardUrl = `https://dashboard.stripe.com/payments/${session.payment_intent}`;

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'HotMarcas <pagamentos@hotmarcas.com.br>',
      to: process.env.OWNER_EMAIL,
      subject: `✅ Novo pagamento — Plano ${tierName} — ${email}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0F0E0B;">
          <div style="background:#1A3454;padding:24px 32px;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:20px;">✅ Novo pagamento confirmado</h1>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;padding:28px 32px;border-radius:0 0 8px 8px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:140px;">Plano</td><td style="padding:8px 0;font-weight:700;">${tierName}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Valor</td><td style="padding:8px 0;font-weight:700;color:#C05028;">${amount}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Nome</td><td style="padding:8px 0;">${name}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}" style="color:#1A3454;">${email}</a></td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Data/hora</td><td style="padding:8px 0;">${date}</td></tr>
            </table>
            <div style="margin-top:24px;">
              <a href="${dashboardUrl}" style="display:inline-block;background:#1A3454;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">
                Ver no Stripe Dashboard →
              </a>
            </div>
            <p style="margin-top:24px;font-size:12px;color:#9ca3af;">
              Lembre-se: entre em contato com o cliente para iniciar o processo de registro.
            </p>
          </div>
        </div>
      `,
    });
  }

  res.status(200).json({ received: true });
};
