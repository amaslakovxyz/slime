# list_products

```
roles: user
reads: products
rule: Return the tenant's catalog of products that are in stock (stock > 0), sorted by id. Response: { products: [{ id, sku, name, price_cents, stock }] }. Writes nothing.
try: {}
```
