CREATE TABLE public.customers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE
);
CREATE TABLE public.products (
  sku text PRIMARY KEY,
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);
CREATE TABLE public.carts (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.customers(id),
  coupon text,
  total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0)
);
CREATE INDEX carts_customer_id_idx ON public.carts(customer_id);
CREATE TABLE public.cart_items (
  cart_id integer NOT NULL REFERENCES public.carts(id),
  product_sku text NOT NULL REFERENCES public.products(sku),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  PRIMARY KEY (cart_id, product_sku)
);
CREATE INDEX cart_items_product_sku_idx ON public.cart_items(product_sku);
