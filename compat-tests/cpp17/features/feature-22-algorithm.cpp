#include <algorithm>
#include <iostream>
#include <vector>
int main(){ std::vector<int> v{3,1,2}; std::sort(v.begin(),v.end()); std::cout<<v[0]<<v[1]<<v[2]<<"\n"; }
