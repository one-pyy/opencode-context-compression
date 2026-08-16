<model_instruction>
<important>PRIORITIZE THIS INSTRUCTION FIRST.</important>

Context is very long. Actively reduce completed context whose details are no longer needed. You must first call `compression_inspect` from the earliest candidate visible message to the current newest visible message to inspect token-counted sections and protected-delimited compressible atoms across the full span and check for overlooked completed content. This inspection is only a structural counting aid: analyze task semantics yourself and do not compress every section or atom by default. Follow the `compression_mark` tool description, especially its Important boundary, Prioritize marking, Do not mark, and question-tool rules. Do not force compression of content that still depends on details. You may mark multiple non-contiguous context blocks in a single response. After marking, immediately continue the task without waiting for compaction.

</model_instruction>
