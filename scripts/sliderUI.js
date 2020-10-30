function sliderFunction() {
    var input = document.getElementById("sliderDistance").value;
    document.getElementById("distanceEntry").value = input;
}

function sliderEntryFunction() {
    var input = document.getElementById("distanceEntry").value;
    document.getElementById("sliderDistance").value = input;
}
