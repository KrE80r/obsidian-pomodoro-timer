<script lang="ts">
import { afterUpdate } from 'svelte'

export let render: (content: string, el: HTMLElement) => void
export let text: string = ''
export let content: string = ''
export let checked: boolean = false
let el: HTMLDivElement
afterUpdate(() => {
    el.empty()
    render(content || text, el)
})
</script>

<div class="task-item-container">
    {#if checked}
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="task-checkbox task-checkbox-checked"
            ><path d="M20 6 9 17l-5-5" /></svg
        >
    {:else}
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="task-checkbox"
            ><circle cx="12" cy="12" r="10" /></svg
        >
    {/if}
    <div bind:this={el} class="task-item-text"></div>
</div>

<style>
.task-item-container {
    display: flex;
    align-items: center;
    gap: 4px;
}

.task-checkbox {
    flex-shrink: 0;
    margin-right: 4px;
}

.task-checkbox-checked {
    color: var(--color-green);
}

.task-item-text {
    flex: 1;
    overflow: hidden;
    width: 100%;
    pointer-events: none;
    cursor: pointer;
}
</style>
