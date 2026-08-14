<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <!--
    The chrome lives in the layout, not here: the sign-in and error pages stand on their
    own with no navigation, while the back office pages are wrapped in
    `layouts/AppShell.vue` through nested routes. A second layout — a full-screen one with
    no navigation at all — is added the same way, and this file does not change.
  -->
  <RouterView />
</template>
