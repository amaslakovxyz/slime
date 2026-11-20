# restock

```
roles: admin
reads: products
writes: products(update)
rule: Add input.qty (integer >= 1, else error BAD_QTY) to the stock of product input.productId (unknown => error PRODUCT_NOT_FOUND) by updating the product row by id. Response: { stock }.
try: {productId: 4, qty: 10}
```
