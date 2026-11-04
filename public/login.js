document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button"), m = document.getElementById("m");
  btn.disabled = true; m.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: document.getElementById("pw").value }),
    });
    if (res.ok) { location.reload(); return; }
    const d = await res.json().catch(() => ({}));
    m.textContent = d.error || "로그인하지 못했습니다.";
  } catch {
    m.textContent = "서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.";
  }
  btn.disabled = false;
});
