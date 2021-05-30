const adminPw = document.getElementById("adminPw");
const login = () => {
  fetch("/admin", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      password: adminPw.value
    })
  }).then((r) => {
    location.href = "/";
  });
};

adminPw.addEventListener("keypress", (e) => {
  if (e.key === "Enter") login();
});
document.getElementById("login").addEventListener("click", login);
