import "./components/writer";
import "./components/reader";

document.getElementById("logout").addEventListener("click", () => {
  fetch("/admin", { method: "DELETE" }).then((r) => {
    location.href = "/";
  });
});

document.getElementById("refresh").addEventListener("click", () => {
  getMails();
});
