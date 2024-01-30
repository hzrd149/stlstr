<script lang="ts">
  import { createEventDispatcher } from "svelte";
  // import { stl2png } from "../services/stl-to-png";
  import { Fileupload } from "flowbite-svelte";

  // let thumbnail: string = "";
  const dispatch = createEventDispatcher();

  const handleFile = (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    console.log("Reading", file.name);
    const reader = new FileReader();
    reader.onload = async () => {
      if (reader.result instanceof ArrayBuffer) {
        dispatch("file", reader.result);
        // const result = await stl2png(reader.result);
        // thumbnail = URL.createObjectURL(result);
      }
    };
    reader.readAsArrayBuffer(file);
  };
</script>

<Fileupload accept="model/stl" on:change={handleFile} />
