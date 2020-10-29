var rangeslider = document.getElementById("sliderDistance");
var output = document.getElementById("distanceEntry");
output.innerHTML = rangeslider.value;
rangeslider.oninput = function() {
    output.innerHTML = this.value;
}