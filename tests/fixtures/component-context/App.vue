<script setup>
import { defineComponent, h } from 'vue'

const privacyReads = { props: 0, state: 0, source: 0, file: 0 }
Object.defineProperty(globalThis, '__VUE_PRIVACY_READS__', { value: privacyReads })

const OptionsCard = defineComponent({
  name: 'OptionsCard',
  setup() { return () => h('article', { 'data-component': 'OptionsCard' }, [h('button', { id: 'vue-options-button' }, 'Options button')]) },
})

const SlotOwner = defineComponent({
  name: 'SlotOwner',
  setup(_props, { slots }) { return () => h('section', { 'data-component': 'SlotOwner' }, slots.default?.()) },
})

const FunctionalLeaf = () => h('button', { id: 'vue-functional-button' }, 'Functional button')
FunctionalLeaf.displayName = 'FunctionalLeaf'

const AnonymousLeaf = defineComponent({
  setup() { return () => h('button', { id: 'vue-anonymous-button' }, 'Anonymous button') },
})

const FragmentLeaf = defineComponent({
  name: 'FragmentLeaf',
  setup() { return () => [h('button', { id: 'vue-fragment-first' }, 'Fragment first'), h('button', { id: 'vue-fragment-later' }, 'Fragment later')] },
})

const KeptLeaf = defineComponent({
  name: 'KeptLeaf',
  setup() { return () => h('button', { id: 'vue-kept-button' }, 'Kept button') },
})

const SensitiveLeaf = defineComponent({
  name: 'SensitiveLeaf',
  setup() { return () => h('button', { id: 'vue-sensitive-button' }, 'Sensitive button') },
})
Object.defineProperty(SensitiveLeaf, '__file', {
  configurable: true,
  get() { privacyReads.file += 1; throw new Error('forbidden:__file') },
})
</script>

<template>
  <main data-component="App">
    <OptionsCard />
    <SlotOwner><button id="vue-slotted-button" type="button">Slotted button</button></SlotOwner>
    <FunctionalLeaf />
    <AnonymousLeaf />
    <FragmentLeaf />
    <Teleport to="#vue-teleport"><button id="vue-teleport-button" type="button">Teleport button</button></Teleport>
    <KeepAlive><KeptLeaf /></KeepAlive>
    <Suspense><SensitiveLeaf /></Suspense>
    <section id="vue-static-block"><span id="vue-static-first">Static first</span><span id="vue-static-later">Static later</span></section>
    <div id="vue-manual-host"></div>
  </main>
</template>
