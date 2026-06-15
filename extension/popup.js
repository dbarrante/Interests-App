var btn = document.getElementById("captureBtn");
var status = document.getElementById("status");
var info = document.getElementById("info");

btn.onclick = function() {
  btn.disabled = true;
  btn.textContent = "Capturing...";
  status.textContent = "";
  chrome.runtime.sendMessage({ action: "manualCapture" }, function(resp) {
    if (chrome.runtime.lastError) {
      status.textContent = "Error: " + chrome.runtime.lastError.message;
      btn.textContent = "Capture this page";
      btn.disabled = false;
      return;
    }
    if (resp && resp.ok) {
      btn.textContent = "Captured!";
      status.textContent = "Card will update shortly";
      setTimeout(function(){ btn.textContent = "Capture this page"; btn.disabled = false; }, 2000);
    } else {
      status.textContent = resp ? resp.error : "No response from extension";
      btn.textContent = "Capture this page";
      btn.disabled = false;
    }
  });
};

chrome.storage.local.get("ia_capture_queue", function(stored) {
  var q = (stored && stored.ia_capture_queue) || [];
  info.textContent = "Queue: " + q.length + " capture(s)";
});
