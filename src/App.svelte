<script lang="ts">
  import Router from "svelte-spa-router";
  import { wrap } from "svelte-spa-router/wrap";
  import NotFound from "./pages/404.svelte";
  import Home from "./pages/things/Home.svelte";
  import TopNav from "./components/TopNav.svelte";

  const routes = {
    "/": Home,
    "/things/new": wrap({
      asyncComponent: () => import("./pages/things/New.svelte"),
    }),
    "/thing/:naddr": wrap({
      asyncComponent: () => import("./pages/thing/Thing.svelte"),
    }),
    "/user/:id": wrap({
      asyncComponent: () => import("./pages/user/User.svelte"),
    }),
    "/parts": wrap({
      asyncComponent: () => import("./pages/parts/Parts.svelte"),
    }),
    "/parts/new": wrap({
      asyncComponent: () => import("./pages/parts/New.svelte"),
    }),
    "/part/:id": wrap({
      asyncComponent: () => import("./pages/part/Part.svelte"),
    }),
    "*": NotFound,
  };
</script>

<TopNav />
<div class="mx-auto flex w-full flex-col gap-2 px-2 pb-10 md:max-w-screen-lg">
  <Router {routes} />
</div>
