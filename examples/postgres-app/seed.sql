INSERT INTO public.customers(id,email) OVERRIDING SYSTEM VALUE VALUES (1,'alice@example.test'),(2,'bob@example.test');
INSERT INTO public.products(sku,price_cents) VALUES ('coffee',5000),('tea',3000);
INSERT INTO public.carts(id,customer_id,total_cents) VALUES (42,1,5000),(99,2,3000);
INSERT INTO public.cart_items(cart_id,product_sku,quantity) VALUES (42,'coffee',1),(99,'tea',1);
