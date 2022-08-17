var waypoint_name_list = [];

// Create the map.
function initMap() {
  const directionsService = new google.maps.DirectionsService();
  const directionsRenderer = new google.maps.DirectionsRenderer({
    draggable: true,
  });

  var toronto = { lat: 43.6532, lng: -79.3852 };
  const map = new google.maps.Map(document.getElementById("map"), {
    center: toronto,
    zoom: 15,
    styles: [
      {
        stylers: [
          {
            hue: "#2c3e50",
          },
          {
            saturation: 250,
          },
        ],
      },
      {
        featureType: "road",
        elementType: "geometry",
        stylers: [
          {
            lightness: 50,
          },
          {
            visibility: "simplified",
          },
        ],
      },
      {
        featureType: "road",
        elementType: "labels",
        stylers: [
          {
            visibility: "off",
          },
        ],
      },
    ],
  });

  // Create the search box and link it to the UI element.
  const input = document.getElementById("homeloc");
  const searchBox = new google.maps.places.SearchBox(input);
  // Listen for the event fired when the user selects a prediction and retrieve
  // more details for that place.
  searchBox.addListener("places_changed", () => {
    calculateAndDisplayRoute(directionsService, directionsRenderer);
    nearbySearch();
    directionsRenderer.setMap(map);
  });

  document.getElementById("sliderDistance").addEventListener("click", () => {
    nearbySearch();
  });

  const onChangeHandler = function () {
    calculateAndDisplayRoute(directionsService, directionsRenderer);
  };

  // Clear the waypoint list between different location searches
  var clearWaypoints = function () {
    waypoint_name_list.length = 0;
  };

  // Get user input (address and distance) and use those in the nearbySearch query
  var nearbySearch = function () {
    var address = document.getElementById("homeloc").value;
    var distance = document.getElementById("sliderDistance").value;
    var radius = distance;

    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: address }, (results, status) => {
      if (status === "OK") {
        if (results[0]) {
          var last = {
            lat: results[0].geometry.location.lat(),
            lng: results[0].geometry.location.lng(),
          };
          // Create the places service.
          const service = new google.maps.places.PlacesService(map);
          // Perform a nearby search.
          service.nearbySearch(
            { location: last, radius: radius, type: "park" },
            (results, status, pagination) => {
              if (status !== "OK") return;
              createList(results, map);

              if (pagination.hasNextPage) {
                getNextPage = pagination.nextPage;
              }
            }
          );
        } else {
          alert(
            "Geocode was not successful for the following reason: " + status
          );
        }
      } else {
        window.alert("Geocoder failed due to: " + status);
      }
    });
  };

  // Create a list of nearby waypoints with their place IDs that the user can select from
  var createList = function (places) {
    const placesList = document.getElementById("places");

    if (placesList.childElementCount > 0) {
      const x = placesList.childElementCount;
      for (i = 0; i < x; i++) {
        var myobj = document.getElementById("apple" + i);
        var my_link = document.getElementById("banana" + i);
        my_link.className = "deselected_waypoint";
        myobj.remove();
      }
    }

    for (let i = 0, place; (place = places[i]); i++) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      var p = document.createElement("p");
      li.innerHTML = place.name;
      a.href = "#";
      li.id = "apple" + i;
      a.id = "banana" + i;
      a.innerText = place.place_id;
      li.appendChild(a);
      placesList.appendChild(li);
      li.setAttribute("class", "deselected_waypoint");
      document.getElementById("banana" + i).style.visibility = "hidden";
      li.addEventListener(
        "click",
        function (e) {
          clicked_id = e.target.id;
          is_selected = e.target.className;
          selected_waypoint(
            clicked_id,
            is_selected,
            directionsRenderer,
            directionsService
          );
        },
        false
      );
    }
  };

  // All of the asynchronous function calls are written below

  document.getElementById("submit").addEventListener("click", onChangeHandler);

  document
    .getElementById("homeloc")
    .addEventListener("change", onChangeHandler);

  document.getElementById("homeloc").addEventListener("change", nearbySearch);

  document.getElementById("homeloc").addEventListener("change", clearWaypoints);

  document
    .getElementById("sliderDistance")
    .addEventListener("change", nearbySearch);

  document
    .getElementById("sliderDistance")
    .addEventListener("change", clearWaypoints);

  document
    .getElementById("distanceEntry")
    .addEventListener("change", nearbySearch);

  document
    .getElementById("distanceEntry")
    .addEventListener("change", clearWaypoints);
}

// This function is called when the user clicks the UI button requesting
// a geocode of a place ID.
geocodePlaceId = (
  geocoder,
  place_ID,
  directionsRenderer,
  directionsService
) => {
  geocoder.geocode({ placeId: place_ID }, (results, status) => {
    if (results[0]) {
      if (!waypoint_name_list.includes(results[0].formatted_address)) {
        waypoint_name_list.push(results[0].formatted_address);
        calculateAndDisplayRoute(directionsService, directionsRenderer);
        console.log(waypoint_name_list);
      } else {
        var index = waypoint_name_list.indexOf(results[0].formatted_address);
        waypoint_name_list.splice(index, 1);
        calculateAndDisplayRoute(directionsService, directionsRenderer);
        console.log(waypoint_name_list);
      }
    } else {
      window.alert("No results found");
    }
  });
};

// Make a list of all selected waypoints
function selected_waypoint(
  clicked_id,
  is_selected,
  directionsRenderer,
  directionsService
) {
  // Create the geocoder service.
  const geocoder = new google.maps.Geocoder();

  var entered_waypoints = document.getElementsByClassName("selected_waypoint");
  entered_waypoints_list = [];

  for (i = 0; i < entered_waypoints.length; i++) {
    entered_waypoints_list.push(
      entered_waypoints[i].firstChild.nextSibling.textContent
    );
  }
  var place_ID =
    document.getElementById(clicked_id).firstChild.nextSibling.textContent;
  // Update the list each time a waypoint is selected/deselected
  if (is_selected == "deselected_waypoint") {
    document
      .getElementById(clicked_id)
      .setAttribute("class", "selected_waypoint");
    entered_waypoints_list.push(place_ID);
    geocodePlaceId(geocoder, place_ID, directionsRenderer, directionsService);
  } else if (is_selected == "selected_waypoint") {
    document
      .getElementById(clicked_id)
      .setAttribute("class", "deselected_waypoint");
    entered_waypoints_list.pop(place_ID);
    geocodePlaceId(geocoder, place_ID, directionsRenderer, directionsService);
  } else {
    document
      .getElementById(clicked_id)
      .setAttribute("class", "selected_waypoint");
    entered_waypoints_list.push(place_ID);
    geocodePlaceId(geocoder, place_ID, directionsRenderer, directionsService);
  }
}

// Create a route with a given location and waypoints
function calculateAndDisplayRoute(directionsService, directionsRenderer) {
  const waypts = [];

  for (let i = 0; i < waypoint_name_list.length; i++) {
    waypts.push({
      location: waypoint_name_list[i],
      stopover: true,
    });
  }
  console.log(waypts);

  directionsService.route(
    {
      origin: document.getElementById("homeloc").value,
      destination: document.getElementById("homeloc").value,
      waypoints: waypts,
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.WALKING,
    },
    (response, status) => {
      if (status === "OK") {
        directionsRenderer.setDirections(response);
        const route = response.routes[0];
      }
    }
  );
}
