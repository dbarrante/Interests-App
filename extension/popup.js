var clipBtn = document.getElementById("clipBtn");
var removeBtn = document.getElementById("removeBtn");
var status = document.getElementById("status");
var info = document.getElementById("info");

clipBtn.onclick = function() {
  clipBtn.disabled = true;
  clipBtn.textContent = "Clipping…";
  status.textContent = "";
  chrome.runtime.sendMessage({ action: "clipPage" }, function(resp) {
    if (chrome.runtime.lastError) {
      status.textContent = "Error: " + chrome.runtime.lastError.message;
    } else if (resp && resp.ok) {
      clipBtn.textContent = resp.delivered ? "Clipped ✓" : "Saved (open the app)";
      status.textContent = resp.delivered ? "Added to Saved — categorizing" : "Will appear when the Interests app is open";
    } else {
      status.textContent = resp ? resp.error : "No response from extension";
    }
    setTimeout(function(){ clipBtn.innerHTML = "&#128206; Clip this page to Interests"; clipBtn.disabled = false; }, 2500);
  });
};

removeBtn.onclick = function() {
  removeBtn.disabled = true;
  removeBtn.textContent = "Removing...";
  status.textContent = "";
  chrome.runtime.sendMessage({ action: "removeCard" }, function(resp) {
    if (chrome.runtime.lastError) {
      status.textContent = "Error: " + chrome.runtime.lastError.message;
    } else if (resp && resp.ok) {
      removeBtn.textContent = "Removed";
      status.textContent = "Card removed (undo from the app)";
    } else {
      status.textContent = resp ? resp.error : "No response from extension";
    }
    setTimeout(function(){ removeBtn.textContent = "Remove this card from Interests"; removeBtn.disabled = false; }, 2000);
  });
};

function refresh() {
  chrome.runtime.sendMessage({ action: "getStatus" }, function(resp) {
    if (chrome.runtime.lastError) {
      info.textContent = "SW not responding: " + chrome.runtime.lastError.message;
      return;
    }
    if (!resp) { info.textContent = "No response from service worker"; return; }
    var lines = [];
    lines.push("Queue: " + resp.queue + " pending");
    if (resp.status) {
      var ago = Math.round((Date.now() - resp.status.ts) / 1000);
      var cls = resp.status.ok ? "ok" : "err";
      lines.push('<span class="' + cls + '">' + resp.status.message + '</span> (' + ago + 's ago)');
    } else {
      lines.push("No capture yet");
    }
    info.innerHTML = lines.join("<br>");
  });
}

refresh();
setInterval(refresh, 1000);
