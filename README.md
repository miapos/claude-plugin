# miaPOS plugin for Claude

Add **miaPOS checkout** to an online shop or web app with Claude. Customers pay by QR code or jump straight into their banking app. The money moves account-to-account through **MIA**, Moldova's instant payment system.

The plugin knows the miaPOS e-commerce API and its pitfalls, and comes with a **live sandbox**. Claude can create a test payment, watch it complete and check a callback signature for you. **Sandbox only: the plugin never moves real money.**

| Market | Status |
|---|---|
| Moldova (MIA instant payments, MDL) | live |
| Romania (RoPay) | contact our team for integration support: [miapos.eu/en/support](https://miapos.eu/en/support?utm_source=claude-plugin&utm_campaign=ro) |

## Install (Claude Code)

```
/plugin marketplace add miapos/claude-plugin
/plugin install miapos@miapos
```

Then just ask, for example:

- "Add miaPOS checkout to my Express shop."
- "Set up the miaPOS WooCommerce module and test a payment in the sandbox."
- "Why does my miaPOS callback signature check fail?"
- "Review my miaPOS integration before we go live."

## What's inside

**Skills**

| Skill | Use it for |
|---|---|
| `integrate-miapos-checkout` | Choose a ready module (WooCommerce, OpenCart, CS-Cart), the PHP SDK or the HTTP API, then implement token → payment → redirect → callback → status → reconciliation |
| `verify-miapos-callback` | The exact signature algorithm, a real test vector, and handlers in Node.js, Python and PHP |
| `miapos-go-live` | Pre-launch audit of an integration: credentials, idempotency, reconciliation, test evidence |

**MCP server** `https://mcp.miapos.eu/mcp`. No login, sandbox only.

| Tool | What it does |
|---|---|
| `search_docs` | Search the miaPOS developer documentation |
| `get_api_reference` | Endpoints, fields, statuses and errors as observed on the live sandbox |
| `check_site` | Check a shop's site for checkout readiness (HTTPS, platform, plugin fit) |
| `sandbox_create_payment` | Create a test payment and get its checkout page and QR |
| `sandbox_simulate_payment` | Make the sandbox complete the payment (about 10 s) |
| `sandbox_payment_status` | Current status, plus the signed callback the sandbox sent |
| `verify_callback_signature` | Check a callback body and signature against the sandbox key, or a key you provide |

## Ready modules and SDK

- WooCommerce: [miapos/mia-pay-gateway-for-woocommerce](https://github.com/miapos/mia-pay-gateway-for-woocommerce)
- OpenCart 3: [miapos/mia-pay-gateway-for-opencart](https://github.com/miapos/mia-pay-gateway-for-opencart)
- CS-Cart: [miapos/mia-pay-gateway-for-cscart](https://github.com/miapos/mia-pay-gateway-for-cscart)
- PHP SDK: `composer require miapos/mia-pos-sdk` · [miapos/mia-pay-ecomm-php-sdk](https://github.com/miapos/mia-pay-ecomm-php-sdk)
- Protocol docs: [miapos/mia-pay-ecomm-integration](https://github.com/miapos/mia-pay-ecomm-integration)

## Privacy

The MCP server needs no account. It processes only what you send it: test payment parameters, callback bodies, a site URL for `check_site`. It does not store your code. Details: [miapos.eu/en/legal/privacy](https://miapos.eu/en/legal/privacy).

## Support

[miapos.eu/en/support](https://miapos.eu/en/support) · info@miapos.eu

## License

MIT © Finergy Tech
