/** Hands the browser a file to save under `name`. */
export function saveFile(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // Chrome drops the name of a detached link, or of a URL revoked before the save starts,
  // and saves the blob under its UUID with no extension.
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
