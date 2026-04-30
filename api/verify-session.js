const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string' || !id.startsWith('cs_')) {
    return res.status(400).json({ paid: false });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.retrieve(id);

  if (session.payment_status !== 'paid') {
    return res.status(200).json({ paid: false });
  }

  const tierName = session.metadata?.tierName || session.metadata?.tier || 'Essencial';
  const email = session.customer_details?.email || '';
  const name = session.customer_details?.name || '';

  res.status(200).json({ paid: true, tierName, email, name });
};
